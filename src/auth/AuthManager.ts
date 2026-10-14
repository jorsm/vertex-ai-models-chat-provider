import * as vscode from "vscode";
import { runGcloud } from "../utils/gcloud";
import { Logger } from "../utils/Logger";
import { DirectGcpAuth } from "./DirectGcpAuth";
import { AuthConfigurationError, GCLOUD_MAX_TIMEOUT_RETRIES } from "./AuthCredentials";
import type { AuthMethod, AuthOptions } from "./AuthCredentials";
import { ProxyAuth } from "./ProxyAuth";

export { AuthConfigurationError };
export type { AuthMethod, AuthMethodType, AuthOptions } from "./AuthCredentials";

/** Duration of a successfully resolved client-identity cache entry. */
const IDENTITY_CACHE_TTL_MS = 60_000;

/**
 * Coordinates direct credentials, independent proxy authentication, and shared client identity metadata.
 *
 * @remarks
 * The identity used for client labels is shared across both transports and is
 * independent of the personal ID token used to authenticate proxy requests.
 */
export class AuthManager {
    private readonly logger = new Logger("AuthManager");

    private readonly directAuth: DirectGcpAuth;
    private readonly proxyAuth: ProxyAuth;

    /** Identity and expiry cached for one minute after a successful lookup. */
    private identityCache: { value: string; expires: number } | undefined;

    /** Shares one in-flight identity lookup among concurrent callers. */
    private identityPromise: Promise<string | undefined> | undefined;

    /**
     * Generation used to ignore a lookup result after workspace auth changes.
     * @see {@link AuthManager.notifyAuthUpdated}
     */
    private identityRevision = 0;

    /**
     * Tail of the serialized gcloud command chain.
     *
     * @remarks
     * Each operation is appended by {@link AuthManager.runGcloudOperation} so
     * Cloud SDK commands do not overlap while using shared configuration files.
     */
    private gcloudOperationQueue: Promise<void> = Promise.resolve();

    private readonly _onAuthUpdated = new vscode.EventEmitter<void>();

    /**
     * Fires when workspace authentication is updated, after the identity cache is cleared.
     *
     * @eventProperty
     */
    public readonly onAuthUpdated = this._onAuthUpdated.event;

    /**
     * Creates the authentication components with one shared CLI operation queue.
     *
     * @param context - Owns stored credentials and the workspace authentication selection.
     */
    constructor(context: vscode.ExtensionContext) {
        this.directAuth = new DirectGcpAuth(context, () => this.notifyAuthUpdated(), this.logger);
        this.proxyAuth = new ProxyAuth((operation) => this.runGcloudOperation(operation), this.logger);
    }

    /**
     * Returns the raw authentication method configuration for the current workspace.
     *
     * @returns The selected method, or `undefined` if this workspace has no saved selection.
     */
    public getActiveMethod(): AuthMethod | undefined {
        return this.directAuth.getActiveMethod();
    }

    /**
     * Resolves the selected workspace credential, or the default credential
     * source when no explicit method is selected. Returns undefined for ADC;
     * missing or invalid selected secrets, and unavailable or unparseable
     * selected files, throw AuthConfigurationError.
     *
     * @returns Credential options, or `undefined` when ADC should be used.
     * @throws An {@link AuthConfigurationError} if a selected secret is missing or
     * invalid, or a selected file is unavailable or cannot be parsed.
     */
    public async getResolvedAuthOptions(): Promise<AuthOptions | undefined> {
        return this.directAuth.getResolvedAuthOptions();
    }

    /**
     * Prompts for a Service Account JSON key, stores it securely, and activates it for this workspace.
     *
     * @returns `true` if the key was stored and activated; otherwise `false` if a prompt was canceled or replacement was declined.
     */
    public async setServiceAccountKey(): Promise<boolean> {
        return this.directAuth.setServiceAccountKey();
    }

    /**
     * Command: Import a Service Account JSON file into VS Code SecretStorage.
     * The selected file is a snapshot; subsequent file edits require re-importing it.
     * A successful import is stored and activated for the current workspace.
     *
     * @returns `true` if the credential was imported and activated; otherwise
     * `false` if a prompt was canceled, replacement was declined, or import failed.
     */
    public async importServiceAccountFile(): Promise<boolean> {
        return this.directAuth.importServiceAccountFile();
    }

    /**
     * Backwards-compatible method name for callers using the previous API.
     *
     * @returns Whether the import succeeded and activated a credential.
     * @see {@link AuthManager.importServiceAccountFile}
     */
    public async setServiceAccountPath(): Promise<boolean> {
        return this.directAuth.setServiceAccountPath();
    }

    /**
     * Prompts to remove a stored Service Account secret from this extension.
     *
     * @returns `true` if the removed credential was active in this workspace;
     * `false` if removal was canceled or the removed credential was inactive.
     * @remarks
     * Removal deletes only the extension's stored copy and name entry.
     * It does not change Google Cloud keys or resources. If the credential was
     * active in this workspace, this workspace is reset to ADC.
     */
    public async removeServiceAccount(): Promise<boolean> {
        return this.directAuth.removeServiceAccount();
    }

    /**
     * Prompts for a workspace authentication method and persists the selection.
     *
     * @returns `true` if a method was selected or the active credential was removed;
     * `false` if canceled or a delegated import/removal operation returns false.
     */
    public async selectAuthMethod(): Promise<boolean> {
        return this.directAuth.selectAuthMethod();
    }

    /**
     * Resets this workspace's authentication selection to Application Default Credentials.
     *
     * @remarks
     * Stored Service Account credentials remain available for later selection.
     */
    public async clearAuthMethod(): Promise<void> {
        return this.directAuth.clearAuthMethod();
    }

    /**
     * Opens a terminal for `gcloud auth application-default login` in the
     * workspace extension host. Resolves after starting the terminal; an
     * optional callback runs after shell integration reports successful login.
     *
     * @param projectId - Project ID to pass to the gcloud login command, if non-empty.
     * @param onSuccess - Optional callback run after successful login activates ADC.
     * @returns Resolves after the terminal command is started, not after login completes.
     */
    public async reauthenticate(projectId: string, onSuccess?: () => void | Promise<void>): Promise<void> {
        return this.directAuth.reauthenticate(projectId, onSuccess);
    }

    /**
     * Returns the label used for the gcloud sign-in action in authentication UI.
     *
     * @returns The label shown for the gcloud sign-in action.
     */
    public getGcloudLoginActionLabel(): string {
        return this.directAuth.getGcloudLoginActionLabel();
    }

    /** Invalidates cached proxy tokens, including acquisitions already in progress. */
    public clearProxyToken(): void {
        this.proxyAuth.clearProxyToken();
    }

    /** Gets a personal proxy ID token independently of the selected direct credentials. */
    public getProxyIdToken(): Promise<string> {
        return this.proxyAuth.getProxyIdToken();
    }

    /**
     * Gets the identity associated with the active authentication source,
     * caching it briefly to avoid repeated CLI calls. Service Account selections
     * use `client_email`; ADC uses the account reported by `gcloud`. Returns
     * undefined when no identity is available.
     *
     * @returns The account email, or `undefined` when no identity is available.
     * @remarks
     * A gcloud command failure returns the last cached identity when
     * available; an unset or invalid account clears the cache.
     */
    public getIdentity(): Promise<string | undefined> {
        if (this.identityCache && this.identityCache.expires > Date.now()) {
            return Promise.resolve(this.identityCache.value);
        }
        if (!this.identityPromise) {
            const promise = this.resolveIdentity(this.identityRevision);
            this.identityPromise = promise;
            void promise
                .finally(() => {
                    if (this.identityPromise === promise) {
                        this.identityPromise = undefined;
                    }
                })
                .catch(() => {});
        }
        return this.identityPromise;
    }

    /** Invalidates cached identity results and notifies authentication listeners. */
    private notifyAuthUpdated(): void {
        this.identityCache = undefined;
        this.identityPromise = undefined;
        this.identityRevision++;
        this._onAuthUpdated.fire();
    }

    /**
     * Resolves `client_email` from credentials when available, otherwise the
     * account reported by gcloud.
     *
     * @param revision - Identity cache generation captured when lookup started.
     * @returns The account email, or `undefined` when none is available or the lookup is stale.
     * @throws An {@link AuthConfigurationError} if a selected secret is missing or
     * invalid, or a selected file cannot be resolved.
     * @remarks
     * Results from outdated revisions are discarded. A gcloud command
     * failure may preserve the previous identity.
     */
    private async resolveIdentity(revision: number): Promise<string | undefined> {
        if (!this.isProxyConfigured()) {
            const authOptions = await this.directAuth.getResolvedAuthOptions(false);
            const credentialIdentity = authOptions?.credentials?.client_email;
            if (typeof credentialIdentity === "string" && credentialIdentity) {
                return this.cacheIdentity(credentialIdentity, revision);
            }
        } else {
            await Promise.resolve();
        }

        const previousIdentity = this.identityCache?.value;
        try {
            const { stdout } = await this.runGcloudOperation(() => this.requestAccountEmail(revision));
            const email = stdout.split(/\r?\n/, 1)[0]?.trim();
            if (email && email !== "(unset)" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
                return this.cacheIdentity(email, revision);
            }
            this.logger.log("Could not extract email from gcloud account output.");
            return this.cacheIdentity(undefined, revision);
        } catch {
            this.logger.log(`Failed to refresh gcloud account email${previousIdentity ? "; keeping the last valid identity" : ""}.`);
            return revision === this.identityRevision ? previousIdentity : undefined;
        }
    }

    private async requestAccountEmail(revision: number): Promise<{ stdout: string; stderr: string }> {
        const maxAttempts = 1 + GCLOUD_MAX_TIMEOUT_RETRIES;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            if (revision !== this.identityRevision) {
                throw new Error("Identity lookup superseded");
            }
            try {
                return await runGcloud(
                    [
                        "config",
                        "get-value",
                        "account",
                    ],
                    undefined,
                    this.logger,
                );
            } catch (error) {
                const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
                if (code !== "GCLOUD_TIMEOUT" || attempt >= maxAttempts || revision !== this.identityRevision) {
                    throw error;
                }
                this.logger.log(`gcloud account command timed out; process terminated, retrying (${attempt}/${GCLOUD_MAX_TIMEOUT_RETRIES}).`);
            }
        }
        throw new Error("Account email lookup exhausted its attempts");
    }

    private isProxyConfigured(): boolean {
        const setting = vscode.workspace.getConfiguration?.("vertexAiChat")?.inspect<string>("proxyUrl");
        return Boolean(setting?.globalValue?.trim() || setting?.defaultValue?.trim());
    }

    /**
     * Caches or clears an identity only while its originating revision is current.
     *
     * @param identity - Resolved account email, or `undefined` to clear an invalid account.
     * @param revision - Identity generation captured before the lookup began.
     * @returns The supplied identity, or `undefined` when the lookup is stale.
     */
    private cacheIdentity(identity: string | undefined, revision: number): string | undefined {
        if (revision !== this.identityRevision) {
            return undefined;
        }
        this.identityCache = identity ? { value: identity, expires: Date.now() + IDENTITY_CACHE_TTL_MS } : undefined;
        return identity;
    }

    /**
     * Runs one Cloud SDK operation after the preceding operation settles.
     *
     * @param operation - Asynchronous command to append to the serialized queue.
     * @typeParam T - Result type returned by the queued operation.
     * @returns A promise for the operation's result; it rejects if the operation fails.
     * @remarks
     * The queue advances after both success and failure because commands
     * share configuration files and must not overlap on Windows.
     */
    private runGcloudOperation<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.gcloudOperationQueue.then(operation, operation);
        this.gcloudOperationQueue = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
    }
}
