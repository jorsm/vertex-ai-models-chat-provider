import { OAuth2Client } from "google-auth-library";
import type { ModelCatalog } from "./providers/VertexModelProvider";
import { parseModelCatalog } from "./ModelCatalogParser";

/** Independent deadlines for the two phases of authenticated catalog discovery. */
export interface ProxyDiscoveryTimeouts {
    /** Maximum wait for a token, including any credential-provider queue time. */
    authenticationTimeoutMs: number;
    /** Maximum HTTP request and response-body duration after authentication succeeds. */
    requestTimeoutMs: number;
}

export class GatewayError extends Error {
    constructor(
        message: string,
        public readonly status?: number,
        public readonly policyCode?: string,
        cause?: unknown,
    ) {
        super(message, cause === undefined ? undefined : { cause });
        this.name = "GatewayError";
    }
}

export function normalizeGatewayError(error: any): GatewayError {
    if (error instanceof GatewayError) {
        return error;
    }
    let payload = error?.error;
    if (!payload && typeof error?.message === "string") {
        try {
            payload = JSON.parse(error.message);
        } catch {
            /* SDK message is not JSON. */
        }
    }
    const detail = payload?.error ?? payload;
    const status = Number(error?.status ?? error?.code ?? detail?.code) || undefined;
    const code = detail?.reason ?? detail?.status;
    const cause = error?.cause;
    const causeCode = cause?.code;
    const causeMessage = typeof cause?.message === "string" ? cause.message : undefined;
    let causeDetail = causeMessage;
    if (causeCode) {
        causeDetail = String(causeCode);
        if (causeMessage) {
            causeDetail += `: ${causeMessage}`;
        }
    }
    let message = detail?.message || error?.message || "Proxy request failed.";
    if (status === 401) {
        return new GatewayError("The proxy rejected your Google ID token. Run 'gcloud auth login' with your personal account, then Refresh Models.", status, code, cause);
    }
    if (causeDetail && !message.includes(causeDetail)) {
        message += ` (cause: ${causeDetail})`;
    }
    return new GatewayError(message, status, code, cause);
}

export function validateProxyUrl(value: string): string {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new GatewayError("Proxy URL must be an absolute HTTPS URL.");
    }
    const local = [
        "localhost",
        "127.0.0.1",
        "[::1]",
    ].includes(url.hostname);
    if ((url.protocol !== "https:" && !(local && url.protocol === "http:")) || url.username || url.password || url.search || url.hash) {
        throw new GatewayError("Proxy URL must use HTTPS (HTTP only on loopback), without credentials, query or fragment.");
    }
    return url.toString().replace(/\/+$/, "");
}

/** Supplies ID-token headers using the Google auth-library v10 Headers contract. */
class GatewayAuthClient extends OAuth2Client {
    constructor(private readonly gateway: ProxyGateway) {
        super();
    }

    override async getRequestHeaders(url?: string): Promise<Headers> {
        if (url) {
            this.gateway.assertDestination(url);
        }
        const token = await this.gateway.getToken();
        if (url) {
            this.gateway.assertDestination(url);
        }
        this.gateway.signal.throwIfAborted();
        return new Headers({ Authorization: `Bearer ${token}` });
    }
}

export function parseProxyCatalog(payload: unknown): ModelCatalog {
    if (!payload || typeof payload !== "object") {
        throw new GatewayError("Invalid proxy discovery response: expected a catalog object.");
    }
    // Accept either envelope, preserving the server's routing configuration.
    const entries = "candidateModels" in payload ? payload.candidateModels : "models" in payload ? payload.models : undefined;
    const regions = "regionPriority" in payload ? payload.regionPriority : undefined;
    if (!Array.isArray(entries) || ("candidateModels" in payload && "models" in payload)) {
        throw new GatewayError("Invalid proxy discovery response: expected candidateModels or a legacy models array.");
    }
    let catalog: ModelCatalog;
    try {
        catalog = parseModelCatalog({ candidateModels: entries, regionPriority: regions });
    } catch (error) {
        throw new GatewayError(`Invalid proxy catalog: ${error instanceof Error ? error.message : error}`);
    }
    return catalog;
}

export class ProxyGateway {
    private readonly controller = new AbortController();
    readonly signal = this.controller.signal;
    dispose(): void {
        this.controller.abort();
    }
    readonly url: string;
    readonly authClient: OAuth2Client;

    constructor(
        url: string,
        readonly getToken: () => Promise<string>,
        private readonly fetcher: typeof fetch = fetch,
    ) {
        this.url = validateProxyUrl(url);
        this.authClient = new GatewayAuthClient(this);
    }

    assertDestination(value: string): void {
        this.signal.throwIfAborted();
        const target = new URL(value);
        const base = new URL(this.url);
        if (target.origin !== base.origin || !(target.pathname.startsWith(`${base.pathname.replace(/\/+$/, "")}/`) || target.pathname === base.pathname)) {
            throw new GatewayError("Refusing to send proxy credentials to another destination.");
        }
    }

    /** Anthropic custom fetch: reject redirects and never forward quota/project headers. */
    readonly fetch: typeof fetch = async (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        this.assertDestination(url);
        const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
        headers.delete("x-goog-user-project");
        headers.delete("x-goog-api-key");
        const response = await this.fetcher(input, { ...init, headers, redirect: "error" });
        return response;
    };

    /**
     * Acquires an ID token, then fetches the catalog with a fresh HTTP deadline.
     * Cancellation ends discovery without waiting for the shared credential provider.
     */
    async discover({ authenticationTimeoutMs, requestTimeoutMs }: ProxyDiscoveryTimeouts, signal?: AbortSignal): Promise<ModelCatalog> {
        const controller = new AbortController();
        const abort = () => controller.abort();
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) {
            abort();
        }
        let timer = setTimeout(abort, authenticationTimeoutMs);
        try {
            const token = await this.acquireDiscoveryToken(controller.signal);
            controller.signal.throwIfAborted();
            clearTimeout(timer);
            timer = setTimeout(abort, requestTimeoutMs);
            return await this.fetchDiscoveryCatalog(token, controller.signal);
        } catch (error) {
            throw normalizeGatewayError(error);
        } finally {
            clearTimeout(timer);
            signal?.removeEventListener("abort", abort);
        }
    }

    private async acquireDiscoveryToken(signal: AbortSignal): Promise<string> {
        if (signal.aborted) {
            throw new GatewayError("Proxy discovery cancelled or timed out.");
        }
        let cancel: (() => void) | undefined;
        try {
            return await new Promise<string>((resolve, reject) => {
                cancel = () => reject(new GatewayError("Proxy discovery cancelled or timed out."));
                signal.addEventListener("abort", cancel, { once: true });
                void this.getToken().then(resolve, reject);
            });
        } finally {
            if (cancel) {
                signal.removeEventListener("abort", cancel);
            }
        }
    }

    private async fetchDiscoveryCatalog(token: string, signal: AbortSignal): Promise<ModelCatalog> {
        const response = await this.fetch(`${this.url}/discovery`, {
            headers: { Authorization: `Bearer ${token}` },
            signal,
        });
        if (!response.ok) {
            await response.body?.cancel();
            throw normalizeGatewayError({ status: response.status, message: `Proxy discovery failed (HTTP ${response.status}).` });
        }
        const reader = response.body?.getReader();
        if (!reader) {
            throw new GatewayError("Empty proxy discovery response.");
        }
        let size = 0;
        const chunks: Uint8Array[] = [];
        try {
            while (true) {
                const { value, done } = await reader.read();
                if (done) {
                    break;
                }
                size += value.byteLength;
                if (size > 1_048_576) {
                    throw new GatewayError("Proxy discovery response exceeds 1 MiB.");
                }
                chunks.push(value);
            }
        } finally {
            await reader.cancel();
            reader.releaseLock();
        }
        return parseProxyCatalog(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    }
}
