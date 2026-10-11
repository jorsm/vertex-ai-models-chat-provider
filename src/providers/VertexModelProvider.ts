import type * as vscode from "vscode";
import type { DiscoveryProbeOptions } from "../utils/discovery";
import type { ProxyGateway } from "../ProxyGateway";
import type { ModelEffortSpec, ResolvedModelRequest } from "../effort/Effort";

/**
 * Token categories returned by a vendor adapter for usage tracking.
 *
 * @remarks
 * Normalization is vendor-specific. Gemini and the exact `xai/grok-4.6`
 * backend subtract cache reads from input; other Grok backends retain the
 * reported prompt count. Claude retains the API's separate input/cache counts.
 * These values can differ from the totals displayed in VS Code's `usage` part.
 */
export interface ModelUsageTokens {
    input: number;
    output: number;
    cache_read: number;
    cache_create: number;
}

/**
 * Diagnostic counters accumulated while mapping a request and consuming its response.
 *
 * @remarks
 * These are the existing adapter counters, rather than a uniform measurement of
 * bytes or characters. For example, Gemini counts image bytes and tool-result
 * parts, while Claude and Grok count base64 image characters and tool-result text.
 * Assistant text includes both supplied history and emitted response text.
 */
export interface CharacterCounts {
    system: number;
    user_text: number;
    assistant_text: number;
    image: number;
    tool_use: number;
    tool_result: number;
}

/** Usage and mapping diagnostics returned after a provider finishes inference. */
export interface ChatInferenceResult {
    /** Vendor-normalized token counts; see {@link ModelUsageTokens}. */
    usage: ModelUsageTokens;
    /** Request and response counters; see {@link CharacterCounts}. */
    charCount: CharacterCounts;
}

/**
 * One canonical model entry from the effective catalog.
 *
 * @remarks
 * The public {@link ModelSpec.id | id} identifies the model in VS Code;
 * {@link ModelSpec.version | version} is the literal backend model path.
 * Thinking effort is configured separately and does not alter either identity.
 */
export interface ModelSpec {
    /** Optional supported effort values and the catalog default. */
    effort?: ModelEffortSpec;
    /** Stable public model identifier used for selection and usage records. */
    id: string;
    /** Adapter routing identifier, such as `google`, `anthropic`, or `grok`. */
    vendor: string;
    displayName: string;
    family: string;
    /** Literal model identifier sent to the vendor endpoint. */
    version: string;
    maxInputTokens: number;
    maxOutputTokens: number;
    capabilities: { imageInput: boolean; toolCalling: boolean };
    /** USD rates per million tokens, consumed by the usage tracker. */
    pricing: {
        input: number;
        output: number;
        cache_read?: number;
        cache_create?: number;
        /**
         * Optional rate card used by the tracker when complete input exceeds
         * `inputThresholdTokens`. The selected rates apply to every token in the
         * request rather than only the portion above that threshold.
         */
        longContext?: {
            inputThresholdTokens: number;
            input: number;
            output: number;
            cache_read?: number;
            cache_create?: number;
        };
    };
}

/** Candidate models and the ordered regions to consider during discovery. */
export interface ModelCatalog {
    candidateModels: ModelSpec[];
    regionPriority: string[];
}

/**
 * Adapter between VS Code chat messages and one vendor's Vertex transport.
 *
 * @remarks
 * Implementations own client configuration and any replay state. Shared retry,
 * cancellation, and discovery policy is provided by the corresponding utilities.
 * Vendor-specific payload conversion and usage normalization remain in the adapter.
 */
export interface VertexModelProvider {
    /** Catalog routing identifier, such as `anthropic`, `google`, or `grok`. */
    vendor: string;

    /**
     * Configure subsequent requests for a project, region, and authentication source.
     *
     * @param projectId - Project used in the Vertex request path.
     * @param region - Catalog-selected endpoint region, including `global`.
     * @param authOptions - Options accepted by the adapter's Google authentication client.
     * @param gateway - Optional proxy transport. Grok accepts configuration but rejects requests through it.
     */
    initialize(projectId: string, region: string, authOptions?: any, gateway?: ProxyGateway): void;

    /**
     * Store default request labels. Per-request labels override these when supplied.
     *
     * @remarks
     * Gemini attaches labels to generation configuration; Claude uses a request
     * header. Grok currently logs them without attaching them to its payload.
     */
    setLabels(labels: Record<string, string>): void;

    /**
     * Probe a literal backend model identifier with a minimal request, without effort settings.
     *
     * @returns Whether the probe succeeds. An aborted probe returns `false`.
     * @throws A `DiscoveryRetryableError` for transient failures handled by discovery policy.
     * @throws Authentication or unsupported-transport errors that prevent probing.
     */
    pingModel(modelId: string, options?: DiscoveryProbeOptions): Promise<boolean>;

    /**
     * Convert history, execute inference, and report response parts to VS Code.
     *
     * @param modelId - Public model identifier, also used as the backend fallback.
     * @param messages - Complete VS Code history, including any tool continuation.
     * @param options - Request options containing tool definitions.
     * @param progress - Receives text, tool calls, and the final `usage` data part when supported.
     * @param token - Cancellation token for the request and shared retry policy.
     * @param labels - Optional labels overriding the stored defaults, including an empty object.
     * @param spec - Optional catalog metadata used by the adapter for request limits.
     * @param request - Resolved model and effort snapshot, preferred for backend identity and effort.
     * @returns Vendor-normalized usage and request/response mapping counters.
     * @throws A VS Code cancellation error when cancellation is observed, or a transport/API error.
     *
     * @remarks
     * The dispatcher currently supplies matching `spec` and `request.spec` values.
     * Adapters retain their existing precedence when these inputs are omitted or differ.
     */
    provideLanguageModelChatResponse(
        modelId: string,
        messages: readonly vscode.LanguageModelChatRequestMessage[],
        options: vscode.ProvideLanguageModelChatResponseOptions,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken,
        labels?: Record<string, string>,
        spec?: ModelSpec,
        request?: ResolvedModelRequest,
    ): Promise<ChatInferenceResult>;

    /**
     * Estimate tokens locally without making an inference request.
     *
     * @remarks
     * Current adapters use the shared character-based heuristic. The dispatcher
     * supplies its own heuristic when an adapter does not implement this method.
     * This estimate is independent of the usage reported after inference.
     */
    provideTokenCount?(text: string | vscode.LanguageModelChatRequestMessage, token: vscode.CancellationToken): Promise<number>;
}
