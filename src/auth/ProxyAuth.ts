import { GatewayError } from "../ProxyGateway";
import { runGcloud } from "../utils/gcloud";
import type { Logger } from "../utils/Logger";
import { GCLOUD_MAX_TIMEOUT_RETRIES, getConfiguredGcloudTimeoutMs } from "./AuthCredentials";

/** Refresh margin applied to the token's actual expiration time. */
const TOKEN_REFRESH_MARGIN_MS = 60_000;

/**
 * Acquires personal proxy ID tokens independently of direct Vertex credentials.
 *
 * @remarks
 * Concurrent callers share one acquisition. Clearing the cache invalidates pending
 * results, and token contents and subprocess output never appear in diagnostics.
 */
export class ProxyAuth {
    /** Personal proxy ID token cached until one minute before its expiration. */
    private proxyToken: { token: string; expires: number } | undefined;

    /** Shares one in-flight token acquisition among concurrent callers. */
    private proxyTokenPromise: Promise<string> | undefined;

    /**
     * Generation captured by token acquisitions so {@link ProxyAuth.clearProxyToken}
     * can invalidate results already in progress.
     */
    private proxyTokenRevision = 0;

    /**
     * @param runGcloudOperation - Queue shared with identity lookups to serialize CLI access.
     * @param logger - Receives timings and sanitized acquisition failures.
     */
    constructor(
        private readonly runGcloudOperation: <T>(operation: () => Promise<T>) => Promise<T>,
        private readonly logger: Logger,
    ) {}

    /**
     * Clears the cached personal CLI token and supersedes any pending request.
     *
     * @remarks
     * A superseded acquisition may finish, but its revision check prevents it
     * from restoring the cache.
     */
    public clearProxyToken(): void {
        this.proxyToken = undefined;
        this.proxyTokenRevision++;
        this.proxyTokenPromise = undefined;
    }

    /**
     * Gets a cached personal `gcloud` ID token for proxy requests.
     * This identity is separate from the credentials used for Vertex AI model
     * requests; the token's signature and authorization are checked by the gateway.
     *
     * @returns The cached token or a newly acquired personal ID token.
     * @throws A {@link GatewayError} if gcloud is unavailable or returns an unusable token.
     * @see {@link ProxyAuth.clearProxyToken}
     */
    public getProxyIdToken(): Promise<string> {
        if (this.proxyToken && this.proxyToken.expires > Date.now()) {
            return Promise.resolve(this.proxyToken.token);
        }
        if (!this.proxyTokenPromise) {
            const promise = this.acquireProxyIdToken(this.proxyTokenRevision);
            this.proxyTokenPromise = promise;
            void promise
                .finally(() => {
                    if (this.proxyTokenPromise === promise) {
                        this.proxyTokenPromise = undefined;
                    }
                })
                // eslint-disable-next-line no-restricted-syntax -- this chain only clears the in-flight promise; callers get the rejection from the returned promise.
                .catch(() => {});
        }
        return this.proxyTokenPromise;
    }

    /**
     * Acquires a token, checks its local claims, and caches only a current revision.
     *
     * @param revision - Token cache generation captured when acquisition started.
     * @returns A locally usable personal ID token.
     * @throws A {@link GatewayError} with a sanitized authentication or CLI availability message.
     */
    private async acquireProxyIdToken(revision: number): Promise<string> {
        const startedAt = Date.now();
        try {
            const token = await this.runGcloudOperation(() => this.requestPersonalToken(revision));
            if (revision !== this.proxyTokenRevision) {
                throw new Error("Token request superseded");
            }
            const expires = getTokenRefreshTime(token);
            this.proxyToken = { token, expires };
            return token;
        } catch (error) {
            const failure = describeTokenFailure(error);
            this.logger.log(`Personal proxy ID token acquisition failed after ${Date.now() - startedAt} ms (${failure.reason}).`);
            throw failure.error;
        }
    }

    /**
     * Runs the personal CLI token command, retrying terminated timeouts.
     *
     * @remarks
     * The shared queue owns the entire retry sequence. Superseded requests cannot retry.
     *
     * @param revision - Cache generation checked before each attempt.
     * @returns The trimmed command output.
     * @throws CLI failures or an error if the request was superseded.
     */
    private async requestPersonalToken(revision: number): Promise<string> {
        const maxAttempts = 1 + GCLOUD_MAX_TIMEOUT_RETRIES;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            if (revision !== this.proxyTokenRevision) {
                throw new Error("Token request superseded");
            }
            const startedAt = Date.now();
            try {
                const result = await runGcloud(
                    [
                        "auth",
                        "print-identity-token",
                        "--quiet",
                        "--verbosity=error",
                    ],
                    getConfiguredGcloudTimeoutMs(),
                    this.logger,
                );
                this.logger.log(`Personal proxy ID token acquired in ${Date.now() - startedAt} ms (attempt ${attempt}).`);
                return result.stdout.trim();
            } catch (error) {
                if (getGcloudFailure(error).code !== "GCLOUD_TIMEOUT" || attempt >= maxAttempts || revision !== this.proxyTokenRevision) {
                    throw error;
                }
                this.logger.log(`gcloud token command timed out; process terminated, retrying (${attempt}/${GCLOUD_MAX_TIMEOUT_RETRIES}).`);
            }
        }
        throw new Error("Personal token acquisition exhausted its attempts");
    }
}

/**
 * Checks token shape and personal-account claims, then computes its cache deadline.
 *
 * @remarks
 * These are local shape checks. The gateway verifies signature and authorization.
 * Parser errors are sanitized so diagnostics cannot contain credential fragments.
 *
 * @param token - Raw CLI token, used only for parsing and subsequent authentication.
 * @returns Expiration time minus the one-minute refresh margin, in milliseconds.
 * @throws A sanitized error if the token or required claims are unusable.
 */
function getTokenRefreshTime(token: string): number {
    const parts = token.split(".");
    const encodedClaims = parts[1];
    if (parts.length !== 3 || !encodedClaims) {
        throw new Error("The personal ID token has an invalid shape");
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(Buffer.from(encodedClaims, "base64url").toString("utf8"));
    } catch {
        throw new Error("The personal ID token has invalid claims");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("The personal ID token has invalid claims");
    }
    const claims = parsed as Record<string, unknown>;
    if (typeof claims.email !== "string" || claims.email.toLowerCase().endsWith(".gserviceaccount.com") || claims.email_verified !== true) {
        throw new Error("The ID token must identify a verified personal account");
    }
    if (typeof claims.exp !== "number") {
        throw new Error("The personal ID token has no numeric expiration");
    }
    const expiresAt = claims.exp * 1000;
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() + TOKEN_REFRESH_MARGIN_MS) {
        throw new Error("The personal ID token is expired or too close to expiration");
    }
    return expiresAt - TOKEN_REFRESH_MARGIN_MS;
}

/** Reads only failure metadata, leaving command output and error messages untouched. */
function getGcloudFailure(error: unknown): { code?: unknown; killed?: unknown; signal?: unknown } {
    return typeof error === "object" && error !== null ? error : {};
}

/** Classifies CLI failures without exposing stderr, token contents, or credential paths. */
function describeTokenFailure(error: unknown): { reason: string; error: GatewayError } {
    const failure = getGcloudFailure(error);
    if (failure.killed || failure.signal) {
        return {
            reason: "gcloud timed out",
            error: new GatewayError("The gcloud token command timed out. This does not mean your Google login expired. Check the Google Agent Platform output and your network, then Refresh Models.", 503),
        };
    }
    if (failure.code === "ENOENT") {
        return {
            reason: "gcloud executable not found",
            error: new GatewayError("Google Cloud CLI was not found in the VS Code extension host PATH. Install gcloud or restart VS Code after updating PATH, then Refresh Models.", 503),
        };
    }
    return {
        reason: "gcloud returned an invalid or unavailable personal token",
        error: new GatewayError("Cannot obtain a personal Google ID token for the proxy. Run 'gcloud auth login' with your user account (without service-account impersonation), then Refresh Models.", 401),
    };
}
