import * as vscode from "vscode";
import { runGcloud } from "../utils/gcloud";
import { Logger } from "../utils/Logger";
import { DirectGcpAuth } from "./DirectGcpAuth";
import { openGcloudLoginTerminal } from "./GcloudLogin";
import { AuthConfigurationError, GCLOUD_MAX_TIMEOUT_RETRIES, getConfiguredGcloudTimeoutMs } from "./AuthCredentials";
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

    /** Returns the workspace selection; see {@link DirectGcpAuth.getActiveMethod}. */
    public getActiveMethod(): AuthMethod | undefined {
        return this.directAuth.getActiveMethod();
    }

    /**
     * Resolves the selected workspace credential, or the default credential
     * source when no explicit method is selected. Returns undefined for ADC;
     * missing or invalid selected secrets, and unavailable or unparseable
     * selected files, throw AuthConfigurationError.
     *
     * @remarks
     * The manager controls ADC fallback logging according to the active transport.
     * Direct credential resolution does not need to inspect proxy configuration.
     *
     * @returns Credential options, or `undefined` when ADC should be used.
     * @throws An {@link AuthConfigurationError} if a selected secret is missing or
     * invalid, or a selected file is unavailable or cannot be parsed.
     */
    public async getResolvedAuthOptions(): Promise<AuthOptions | undefined> {
        return this.directAuth.getResolvedAuthOptions(!this.isProxyConfigured());
    }

    /** Stores and selects a pasted key; see {@link DirectGcpAuth.setServiceAccountKey}. */
    public setServiceAccountKey(): Promise<boolean> {
        return this.directAuth.setServiceAccountKey();
    }

    /** Imports and selects a credential snapshot; see {@link DirectGcpAuth.importServiceAccountFile}. */
    public importServiceAccountFile(): Promise<boolean> {
        return this.directAuth.importServiceAccountFile();
    }

    /** Removes a stored key and reports whether it was active; see {@link DirectGcpAuth.removeServiceAccount}. */
    public removeServiceAccount(): Promise<boolean> {
        return this.directAuth.removeServiceAccount();
    }

    /** Selects workspace credentials; see {@link DirectGcpAuth.selectAuthMethod}. */
    public selectAuthMethod(): Promise<boolean> {
        return this.directAuth.selectAuthMethod();
    }

    /** Selects ADC without deleting stored keys; see {@link DirectGcpAuth.clearAuthMethod}. */
    public clearAuthMethod(): Promise<void> {
        return this.directAuth.clearAuthMethod();
    }

    /**
     * Opens a terminal for gcloud authentication (`gcloud auth login` when a proxy
     * is configured, or `gcloud auth application-default login` in direct mode).
     * Resolves after starting the terminal; an optional callback runs after shell
     * integration reports successful login.
     *
     * @param projectId - Project ID to pass to the gcloud login command, if non-empty.
     * @param onSuccess - Optional callback run after successful login updates credentials.
     * @returns Resolves after the terminal command is started, not after login completes.
     */
    public async reauthenticate(projectId: string, onSuccess?: () => void | Promise<void>): Promise<void> {
        if (this.isProxyConfigured()) {
            openGcloudLoginTerminal(
                projectId,
                async () => {
                    this.clearProxyToken();
                    this.notifyAuthUpdated();
                    void vscode.window.showInformationMessage("Vertex AI: gcloud login updated successfully. Refreshing models…");
                    await onSuccess?.();
                },
                this.logger,
                "proxy",
            );
            return;
        }
        return this.directAuth.reauthenticate(projectId, onSuccess);
    }

    /**
     * Returns the label used for the gcloud sign-in action in authentication UI.
     *
     * @returns The label shown for the gcloud sign-in action.
     */
    public getGcloudLoginActionLabel(): string {
        return "Login with gcloud";
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
                // eslint-disable-next-line no-restricted-syntax -- this chain only clears the in-flight promise; callers get the rejection from the returned promise.
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
            // Yield before queueing, matching the asynchronous direct credential lookup.
            await Promise.resolve();
        }

        const previousIdentity = this.identityCache?.value;
        try {
            // Keep the complete retry sequence in the shared CLI queue.
            const { stdout } = await this.runGcloudOperation(async () => {
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
                            getConfiguredGcloudTimeoutMs(),
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
            });
            const email = stdout.split(/\r?\n/, 1)[0]?.trim();
            if (email && email !== "(unset)" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
                return this.cacheIdentity(email, revision);
            }
            this.logger.log(`Could not extract email from gcloud account output (${email ? `received '${email}'` : "empty output"}).`);
            return this.cacheIdentity(undefined, revision);
        } catch (error) {
            const reason = describeAccountLookupFailure(error);
            this.logger.log(`Failed to refresh gcloud account email (${reason})${previousIdentity ? "; keeping the last valid identity" : ""}.`);
            return revision === this.identityRevision ? previousIdentity : undefined;
        }
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
        if (identity) {
            this.identityCache = { value: identity, expires: Date.now() + IDENTITY_CACHE_TTL_MS };
        } else {
            this.identityCache = undefined;
        }
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

function describeAccountLookupFailure(error: unknown): string {
    if (typeof error === "object" && error !== null) {
        const failure = error as { code?: unknown; killed?: unknown; signal?: unknown; stderr?: unknown; message?: unknown };
        if (failure.code === "GCLOUD_TIMEOUT" || failure.killed || failure.signal) {
            return `gcloud timed out${failure.signal ? ` (${String(failure.signal)})` : ""}`;
        }
        if (failure.code === "ENOENT") {
            return "gcloud executable not found";
        }
        const stderrLine = typeof failure.stderr === "string" ? failure.stderr.trim().split(/\r?\n/, 1)[0]?.trim() : "";
        if (typeof failure.code === "number") {
            return stderrLine ? `exit code ${failure.code}: ${stderrLine}` : `exit code ${failure.code}`;
        }
        if (typeof failure.code === "string" && failure.code) {
            const msg = typeof failure.message === "string" && failure.message ? `: ${failure.message}` : "";
            return `${failure.code}${msg}`;
        }
    }
    if (error instanceof Error && error.message) {
        return error.message;
    }
    return String(error || "unknown error");
}
