import type OpenAI from "openai";
import type { Stream } from "openai/streaming";
import * as vscode from "vscode";
import type { ModelCatalogResolver } from "../ModelCatalogResolver";
import { Logger } from "../utils/Logger";
import { DISCOVERY_PROBE_TIMEOUT_MS, DiscoveryProbeOptions, getDiscoveryRetryableError } from "../utils/discovery";
import { checkAuthError, withRetry } from "../utils/retry";
import { estimateTokens } from "../utils/tokens";
import type { ChatInferenceResult, VertexModelProvider } from "./VertexModelProvider";
import type { ProxyGateway } from "../ProxyGateway";
import type { ModelSpec } from "./VertexModelProvider";
import type { ResolvedModelRequest } from "../effort/Effort";
import { requestCancellation, cancellableRequest } from "../utils/cancellation";

import { mapGrokMessages, mapGrokTools } from "./grok/GrokMessages";
import { processGrokStream } from "./grok/GrokStream";
import { createGrokClient, filterMalformedKeepaliveEvents } from "./grok/GrokTransport";

/**
 * Adapts Vertex's direct OpenAI-compatible Grok endpoint to VS Code chat.
 *
 * Request orchestration remains here; message mapping, streaming and transport
 * normalization live in the corresponding Grok helpers. Proxy transport is
 * rejected before authentication or a request is attempted.
 */
export class VertexGrokProvider implements VertexModelProvider {
    /** Catalog vendor identifier for this adapter. */
    vendor = "grok";
    private projectId!: string;
    private region!: string;
    private authOptions?: any;
    private gateway: ProxyGateway | undefined;
    private labels: Record<string, string> = {};
    private catalogResolver?: ModelCatalogResolver;
    private readonly logger = new Logger("VertexGrokProvider");

    /** Stores the configuration used to create a fresh client for each operation. */
    initialize(projectId: string, region: string, authOptions?: any, gateway?: ProxyGateway): void {
        this.projectId = projectId;
        this.region = region;
        this.authOptions = authOptions;
        this.gateway = gateway;
    }

    /** Injects the catalog resolver so model specs are read from the effective (custom or bundled) catalog. */
    setCatalogResolver(resolver: ModelCatalogResolver): void {
        this.catalogResolver = resolver;
    }

    /** Stores default labels for diagnostic logging; Grok payloads do not send labels. */
    setLabels(labels: Record<string, string>): void {
        this.labels = labels;
    }

    /**
     * Probes an exact catalog model path with one output token and no effort value.
     *
     * Aborted and nonretryable probes return false. Authentication failures and
     * retryable discovery failures propagate to the discovery coordinator.
     * SDK retries are disabled for this bounded probe.
     */
    async pingModel(modelVersion: string, options?: DiscoveryProbeOptions): Promise<boolean> {
        this.assertTransportSupported();
        const modelPath = modelVersion;
        try {
            options?.signal.throwIfAborted();
            const client = await this.getClient();
            options?.signal.throwIfAborted();
            await client.chat.completions.create(
                {
                    model: modelPath,
                    messages: [{ role: "user", content: "ping" }],
                    max_tokens: 1,
                    stream: false,
                },
                { signal: options?.signal, timeout: options?.timeoutMs ?? DISCOVERY_PROBE_TIMEOUT_MS, maxRetries: 0 },
            );
            if (options?.signal.aborted) {
                return false;
            }
            this.logger.log(`    🏓 Grok ${modelVersion} → ✅`);
            return true;
        } catch (e: any) {
            if (options?.signal.aborted) {
                return false;
            }
            checkAuthError(e);
            const retryError = getDiscoveryRetryableError(e);
            if (retryError) {
                throw retryError;
            }
            this.logger.log(`    🏓 Grok ${modelVersion} → ❌ ${e.message || e}`);
            return false;
        }
    }

    /** Estimates tokens locally using the shared character-based heuristic. */
    async provideTokenCount(text: string | vscode.LanguageModelChatRequestMessage, _token: vscode.CancellationToken): Promise<number> {
        return estimateTokens(text);
    }

    /**
     * Maps chat inputs, streams a direct Grok request and reports its usage.
     *
     * Model metadata is taken from the resolved request, then the supplied spec,
     * then the effective catalog. Effort uses the resolved selection when present,
     * otherwise the selected model's default. Per-call labels override stored
     * labels for logging only.
     *
     * @param modelId - Catalog ID used for fallback lookup and diagnostics.
     * @param messages - VS Code history mapped by {@link mapGrokMessages}.
     * @param options - Tool declarations mapped by {@link mapGrokTools}.
     * @param progress - Receives text, tool calls and the final usage data part.
     * @param token - Cancels client acquisition, request creation and streaming.
     * @param labels - Optional labels replacing the adapter's diagnostic defaults.
     * @param spec - Model metadata used when the resolved request supplies none.
     * @param request - Resolved model identity and optional effort selection.
     * @returns Usage counters and the accumulated message character counts.
     * @throws When proxy transport is configured, metadata is unavailable, or
     * authentication, inference or cancellation fails.
     */
    async provideLanguageModelChatResponse(
        modelId: string,
        messages: readonly vscode.LanguageModelChatRequestMessage[],
        options: vscode.ProvideLanguageModelChatResponseOptions,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken,
        labels?: Record<string, string>,
        spec?: ModelSpec,
        request?: ResolvedModelRequest,
    ): Promise<ChatInferenceResult> {
        this.assertTransportSupported();
        // Use passed spec if available, otherwise resolve from catalog
        let modelSpec = request?.spec ?? spec;
        if (!modelSpec) {
            const catalog = await this.catalogResolver?.getEffectiveCatalog();
            modelSpec = catalog?.candidateModels.find((m: ModelSpec) => m.id === modelId);
        }

        if (!modelSpec) {
            throw new Error(`Model spec not found in catalog for: ${modelId}`);
        }
        const modelPath = modelSpec.version;
        const effort = request?.effort?.value ?? modelSpec.effort?.default;

        this.logger.log(`▶ Grok provider response — model: ${modelId} (${modelPath}), region: ${this.region}, messages: ${messages.length}`);

        const requestLabels = labels || this.labels;
        if (Object.keys(requestLabels).length > 0) {
            this.logger.log(`  🏷️  Labels: ${JSON.stringify(requestLabels)}`);
        }

        const cancellation = requestCancellation(token);
        try {
            const charCount = { system: 0, user_text: 0, assistant_text: 0, image: 0, tool_use: 0, tool_result: 0 };

            const mappedMessages = mapGrokMessages(messages, charCount, this.logger);
            const tools = mapGrokTools(options);

            if (cancellation.signal.aborted) {
                throw new vscode.CancellationError();
            }
            const clientPromise = this.getClient();
            const client = await cancellableRequest(() => clientPromise, cancellation.signal);

            const requestParams = {
                model: modelPath,
                messages: mappedMessages as any,
                max_tokens: modelSpec.maxOutputTokens,
                stream: true as const,
                ...(tools?.length ? { tools, tool_choice: "auto" as const } : {}),
                stream_options: { include_usage: true },
                ...(effort ? { reasoning_effort: effort } : {}),
            };
            this.logger.log(`  📤 Request keys: ${Object.keys(requestParams).join(", ")}`);

            const stream = await withRetry<Stream<OpenAI.Chat.Completions.ChatCompletionChunk>>(
                () => cancellableRequest(() => client.chat.completions.create(requestParams as any, { signal: cancellation.signal }) as unknown as Promise<Stream<OpenAI.Chat.Completions.ChatCompletionChunk>>, cancellation.signal),
                { token },
            );

            this.logger.log(`  Stream created successfully`);

            const usage = await processGrokStream(stream, modelPath, charCount, progress, token, this.logger);
            if (cancellation.signal.aborted || token.isCancellationRequested) {
                throw new vscode.CancellationError();
            }

            // Report token usage to VS Code (MIME type 'usage') for Copilot Chat indicator
            if (typeof vscode.LanguageModelDataPart !== "undefined") {
                const promptTokens = usage.input + (modelPath === "xai/grok-4.6" ? usage.cache_read : 0);
                const usagePayload = {
                    prompt_tokens: promptTokens,
                    completion_tokens: usage.output,
                    total_tokens: promptTokens + usage.output,
                    prompt_tokens_details: {
                        cached_tokens: usage.cache_read,
                    },
                };
                progress.report(new vscode.LanguageModelDataPart(new TextEncoder().encode(JSON.stringify(usagePayload)), "usage"));
                this.logger.log(`  📊 Reported token usage to VS Code: ${JSON.stringify(usagePayload)}`);
            }

            return { usage, charCount };
        } catch (e: any) {
            this.logger.log(`  ❌ Grok provideLanguageModelChatResponse error: ${e}`);
            checkAuthError(e);
            throw e;
        } finally {
            cancellation.dispose();
        }
    }

    /** Rejects proxy use before catalog lookup, authentication or network activity. */
    private assertTransportSupported(): void {
        if (this.gateway) {
            throw new Error("Grok proxy transport is not supported yet. No request was sent.");
        }
    }

    /** Obtains a fresh direct client after rejecting unsupported proxy transport. */
    private async getClient(): Promise<OpenAI> {
        this.assertTransportSupported();
        return createGrokClient(this.projectId, this.region, this.authOptions, this.logger, (url, init) => this.fetchVertexStream(url, init));
    }

    /** Fetches the raw response and removes malformed Vertex keepalive lines. */
    private async fetchVertexStream(url: RequestInfo, init?: RequestInit): Promise<Response> {
        const response = await fetch(url, init);
        return this.filterMalformedKeepaliveEvents(response);
    }

    /** Applies the stream normalization used by the OpenAI-compatible client. */
    private filterMalformedKeepaliveEvents(response: Response): Response {
        return filterMalformedKeepaliveEvents(response);
    }
}
