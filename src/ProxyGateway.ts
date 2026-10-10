import { OAuth2Client } from "google-auth-library";
import type { ModelCatalog, ModelSpec } from "./providers/VertexModelProvider";
import { EffortCatalog } from "./effort/EffortCatalog";
import { snapshot } from "./effort/EffortTypes";

export class GatewayError extends Error {
    constructor(
        message: string,
        public readonly status?: number,
        public readonly policyCode?: string,
    ) {
        super(message);
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
    if (status === 401) {
        return new GatewayError("The proxy rejected your Google ID token. Run 'gcloud auth login' with your personal account, then Refresh Models.", status, code);
    }
    return new GatewayError(detail?.message || error?.message || "Proxy request failed.", status, code);
}

export function isGatewayRetryable(error: any): boolean {
    const normalized = normalizeGatewayError(error);
    if (normalized.policyCode === "UPSTREAM_AUTHENTICATION_FAILED") {
        return false;
    }
    return normalized.status === 429 || normalized.status === 503;
}

export function gatewayRetryDelayMs(error: any): number {
    const headers = error?.headers ?? error?.response?.headers;
    const raw = headers?.get?.("retry-after") ?? headers?.["retry-after"];
    if (!raw) {
        return 0;
    }
    const seconds = Number(raw);
    const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(raw) - Date.now();
    return Number.isFinite(delay) ? Math.max(0, delay) : 0;
}

export function validateProxyUrl(value: string): string {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new GatewayError("Proxy URL must be an absolute HTTPS URL.");
    }
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if ((url.protocol !== "https:" && !(local && url.protocol === "http:")) || url.username || url.password || url.search || url.hash) {
        throw new GatewayError("Proxy URL must use HTTPS (HTTP only on loopback), without credentials, query or fragment.");
    }
    return url.toString().replace(/\/+$/, "");
}

/** ID token headers are compatible with both Google auth-library SDK generations. */
class GatewayAuthClient extends OAuth2Client {
    constructor(private readonly gateway: ProxyGateway) {
        super();
    }

    override async getRequestHeaders(url?: string): Promise<any> {
        if (url) {
            this.gateway.assertDestination(url);
        }
        const token = await this.gateway.getToken();
        if (url) {
            this.gateway.assertDestination(url);
        }
        this.gateway.signal.throwIfAborted();
        const headers = { Authorization: `Bearer ${token}` };
        Object.defineProperty(headers, Symbol.iterator, {
            value: function* () {
                yield* Object.entries(headers);
            },
        });
        return headers;
    }
}

export function parseProxyCatalog(payload: unknown): ModelCatalog {
    if (!payload || typeof payload !== "object") {
        throw new GatewayError("Invalid proxy discovery response: expected a catalog object.");
    }
    // Accept either envelope, preserving the server's routing configuration.
    const entries = "candidateModels" in payload ? payload.candidateModels : "models" in payload ? payload.models : undefined;
    const regions = "regionPriority" in payload ? payload.regionPriority : undefined;
    const capabilities = "catalogCapabilities" in payload ? payload.catalogCapabilities : undefined;
    if (capabilities !== undefined && (!Array.isArray(capabilities) || capabilities.some((value) => value !== "effort-v1") || new Set(capabilities).size !== capabilities.length)) {
        throw new GatewayError("Invalid proxy catalog capabilities: expected effort-v1 acknowledgement.");
    }
    const enhanced = Array.isArray(capabilities) && capabilities.includes("effort-v1");
    if (!Array.isArray(entries) || ("candidateModels" in payload && "models" in payload)) {
        throw new GatewayError("Invalid proxy discovery response: expected candidateModels or a legacy models array.");
    }
    if (!Array.isArray(regions) || !regions.every((region) => typeof region === "string" && /^[a-z][a-z0-9-]*$/.test(region)) || (entries.length > 0 && regions.length === 0)) {
        throw new GatewayError("Invalid proxy discovery response: regionPriority must contain valid regions, with at least one region when models are advertised.");
    }
    const ids = new Set<string>();
    const validId = (value: unknown) => typeof value === "string" && /^[a-zA-Z0-9_.@-]{1,256}$/.test(value);
    const validVersion = (value: unknown) => typeof value === "string" && value.length <= 256 && value.split("/").every((segment) => validId(segment) && segment !== "." && segment !== "..");
    const validText = (value: unknown) => typeof value === "string" && value.trim().length > 0 && value.length <= 256;
    const positiveInteger = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0;
    const validRates = (rates: any) =>
        rates && typeof rates === "object" && [rates.input, rates.output].every((rate) => typeof rate === "number" && Number.isFinite(rate) && rate >= 0) && [rates.cache_read, rates.cache_create].every((rate) => rate === undefined || (typeof rate === "number" && Number.isFinite(rate) && rate >= 0));
    const copyRates = (rates: any) => ({ input: rates.input, output: rates.output, ...(rates.cache_read !== undefined ? { cache_read: rates.cache_read } : {}), ...(rates.cache_create !== undefined ? { cache_create: rates.cache_create } : {}) });
    const candidateModels = entries.map((entry: any): ModelSpec => {
        if (
            !entry ||
            !validId(entry.vendor) ||
            !validId(entry.id) ||
            !validVersion(entry.version) ||
            ids.has(entry.id) ||
            !validText(entry.displayName) ||
            !validText(entry.family) ||
            !positiveInteger(entry.maxInputTokens) ||
            !positiveInteger(entry.maxOutputTokens) ||
            typeof entry.capabilities?.imageInput !== "boolean" ||
            typeof entry.capabilities?.toolCalling !== "boolean" ||
            !validRates(entry.pricing) ||
            (entry.pricing.longContext !== undefined && (!validRates(entry.pricing.longContext) || !positiveInteger(entry.pricing.longContext.inputThresholdTokens)))
        ) {
            throw new GatewayError("Invalid proxy catalog: models require unique IDs, vendor identifiers, versions, names, token limits, capabilities and non-negative prices.");
        }
        ids.add(entry.id);
        if (entry.effort !== undefined && !enhanced) {
            throw new GatewayError("Proxy effort metadata requires catalogCapabilities: ['effort-v1'].");
        }
        return {
            id: entry.id,
            vendor: entry.vendor,
            version: entry.version,
            displayName: entry.displayName,
            family: entry.family,
            maxInputTokens: entry.maxInputTokens,
            maxOutputTokens: entry.maxOutputTokens,
            capabilities: { imageInput: entry.capabilities.imageInput, toolCalling: entry.capabilities.toolCalling },
            pricing: {
                ...copyRates(entry.pricing),
                ...(entry.pricing.longContext
                    ? {
                          longContext: { ...copyRates(entry.pricing.longContext), inputThresholdTokens: entry.pricing.longContext.inputThresholdTokens },
                      }
                    : {}),
            },
            ...(entry.effort !== undefined ? { effort: snapshot(entry.effort) } : {}),
        };
    });
    try {
        new EffortCatalog(candidateModels);
    } catch (error) {
        throw new GatewayError(`Invalid proxy catalog: ${error}`);
    }
    return { candidateModels, regionPriority: [...regions] };
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

    async discover(timeoutMs: number, signal?: AbortSignal): Promise<ModelCatalog> {
        const controller = new AbortController();
        const abort = () => controller.abort();
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) {
            abort();
        }
        const timer = setTimeout(abort, timeoutMs);
        try {
            // Also bound token acquisition: aborting discovery must not wait for gcloud.
            const token = await new Promise<string>((resolve, reject) => {
                const cancel = () => reject(new GatewayError("Proxy discovery cancelled or timed out."));
                controller.signal.addEventListener("abort", cancel, { once: true });
                if (controller.signal.aborted) {
                    cancel();
                }
                this.getToken()
                    .then(resolve, reject)
                    .finally(() => controller.signal.removeEventListener("abort", cancel));
            });
            controller.signal.throwIfAborted();
            const response = await this.fetch(`${this.url}/discovery`, {
                headers: { Authorization: `Bearer ${token}`, "X-Vertex-AI-Catalog-Capabilities": "effort-v1" },
                signal: controller.signal,
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
        } catch (error) {
            throw normalizeGatewayError(error);
        } finally {
            clearTimeout(timer);
            signal?.removeEventListener("abort", abort);
        }
    }
}
