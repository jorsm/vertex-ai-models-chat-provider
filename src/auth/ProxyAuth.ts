import { GatewayError } from "../ProxyGateway";
import { runGcloud } from "../utils/gcloud";
import type { Logger } from "../utils/Logger";

/** Acquires personal proxy ID tokens independently of direct Vertex credentials. */
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
     * Gets a cached personal `gcloud` ID token for the proxy POC.
     * This identity is separate from the credentials used for Vertex AI model
     * requests; the token's signature and authorization are checked by the gateway.
     *
     * @returns The cached token or a newly acquired personal ID token.
     * @throws {@link GatewayError}
     * If gcloud is unavailable or returns an unusable token.
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
                .catch(() => {});
        }
        return this.proxyTokenPromise;
    }

    /**
     * Acquires and locally validates a personal ID token for the proxy.
     *
     * @param revision - Token cache generation captured when acquisition started.
     * @returns The acquired ID token.
     * @throws {@link GatewayError}
     * If gcloud fails or the token is unusable.
     * @remarks
     * The gateway verifies the token signature and authorization.
     */
    private async acquireProxyIdToken(revision: number): Promise<string> {
        const startedAt = Date.now();
        try {
            const result = await this.runGcloudOperation(async () => {
                for (let attempt = 1; ; attempt++) {
                    if (revision !== this.proxyTokenRevision) {
                        throw new Error("Token request superseded");
                    }
                    const attemptStartedAt = Date.now();
                    try {
                        const result = await runGcloud([
                            "auth",
                            "print-identity-token",
                            "--quiet",
                            "--verbosity=error",
                        ]);
                        this.logger.log(`Personal proxy ID token acquired in ${Date.now() - attemptStartedAt} ms (attempt ${attempt}).`);
                        return result;
                    } catch (error: any) {
                        if (error?.code !== "GCLOUD_TIMEOUT" || attempt !== 1 || revision !== this.proxyTokenRevision) {
                            throw error;
                        }
                        this.logger.log("gcloud token command timed out; process terminated, retrying once.");
                    }
                }
            });
            const token = result.stdout.trim();
            const parts = token.split(".");
            const encodedClaims = parts[1];
            if (parts.length !== 3 || !encodedClaims) {
                throw new Error();
            }
            // Local shape checks only. Signature/authorization are verified by the gateway.
            const claims = JSON.parse(Buffer.from(encodedClaims, "base64url").toString("utf8"));
            if (revision !== this.proxyTokenRevision || typeof claims.email !== "string" || claims.email.toLowerCase().endsWith(".gserviceaccount.com") || claims.email_verified !== true || typeof claims.exp !== "number" || claims.exp * 1000 <= Date.now() + 60_000) {
                throw new Error();
            }
            // Reuse the CLI token for its actual lifetime. Refresh one minute before
            // expiry instead of invoking gcloud again after every minute.
            this.proxyToken = { token, expires: claims.exp * 1000 - 60_000 };
            return token;
        } catch (error: any) {
            // Never surface subprocess stderr: it can contain bearer tokens or credential paths.
            let reason = "gcloud returned an invalid or unavailable personal token";
            if (error?.killed || error?.signal) {
                reason = "gcloud timed out";
            } else if (error?.code === "ENOENT") {
                reason = "gcloud executable not found";
            }
            this.logger.log(`Personal proxy ID token acquisition failed after ${Date.now() - startedAt} ms (${reason}).`);
            if (error?.killed || error?.signal) {
                throw new GatewayError("The gcloud token command timed out. This does not mean your Google login expired. Check the Google Agent Platform output and your network, then Refresh Models.", 503);
            }
            if (error?.code === "ENOENT") {
                throw new GatewayError("Google Cloud CLI was not found in the VS Code extension host PATH. Install gcloud or restart VS Code after updating PATH, then Refresh Models.", 503);
            }
            throw new GatewayError("Cannot obtain a personal Google ID token for the proxy. Run 'gcloud auth login' with your user account (without service-account impersonation), then Refresh Models.", 401);
        }
    }
}
