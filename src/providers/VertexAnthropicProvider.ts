import { AnthropicVertex } from "@anthropic-ai/vertex-sdk";
import { GoogleAuth } from "google-auth-library";
import * as vscode from "vscode";
import { Logger } from "../utils/Logger";
import { DISCOVERY_PROBE_TIMEOUT_MS, DiscoveryProbeOptions, getDiscoveryRetryableError } from "../utils/discovery";
import { checkAuthError, withRetry } from "../utils/retry";
import { estimateTokens } from "../utils/tokens";
import { ClaudeThinkingReplayCache, claudeEffortConfig } from "./ClaudeThinking";
import { mapClaudeMessages, mapClaudeTools, logClaudeMessages } from "./anthropic/ClaudeMessages";
import { restoreClaudeThinking, applyClaudeCacheControl } from "./anthropic/ClaudeRequestContext";
import { processClaudeStream } from "./anthropic/ClaudeStream";
import type { ResolvedModelRequest } from "../effort/Effort";
import { ChatInferenceResult, ModelSpec, VertexModelProvider } from "./VertexModelProvider";
import { ProxyGateway, isGatewayRetryable, normalizeGatewayError, gatewayRetryDelayMs } from "../ProxyGateway";
import { requestCancellation, cancellableRequest } from "../utils/cancellation";

/**
 * Provides Claude discovery and streaming inference through Vertex or a gateway.
 *
 * @remarks Request conversion, cache markers and stream events are handled by
 * {@link mapClaudeMessages}, {@link applyClaudeCacheControl} and
 * {@link processClaudeStream}; this class owns transport and request lifetimes.
 */
export class VertexAnthropicProvider implements VertexModelProvider {
    /** Catalog vendor handled by this provider. */
    vendor = "anthropic";
    private client!: AnthropicVertex;
    private projectId!: string;
    private region!: string;
    private labels: Record<string, string> = {};
    private readonly logger = new Logger("VertexAnthropicProvider");
    /** Signed tool turns retained until eviction or the next initialization. */
    private thinkingReplayCache = new ClaudeThinkingReplayCache();
    private gateway: ProxyGateway | undefined;

    /**
     * Configures the SDK transport and starts a fresh signed-turn cache.
     *
     * @remarks Gateway requests disable SDK retries; direct requests retain SDK
     * defaults. In-flight inference keeps its previously captured client/cache.
     */
    initialize(projectId: string, region: string, authOptions?: any, gateway?: ProxyGateway): void {
        this.projectId = projectId;
        this.region = region;
        this.gateway = gateway;
        this.thinkingReplayCache = new ClaudeThinkingReplayCache();
        this.client = new AnthropicVertex({
            projectId: this.projectId,
            region: this.region,
            ...(gateway
                ? {
                      baseURL: `${gateway.url}/v1`,
                      authClient: gateway.authClient,
                      fetch: gateway.fetch as any,
                      maxRetries: 0,
                  }
                : authOptions
                  ? {
                        googleAuth: new GoogleAuth({
                            ...authOptions,
                            scopes: "https://www.googleapis.com/auth/cloud-platform",
                        }),
                    }
                  : {}),
        });
    }

    /** Sets labels used when a request does not provide its own label object. */
    setLabels(labels: Record<string, string>): void {
        this.labels = labels;
    }

    /**
     * Probes availability with a one-token response and no SDK retries.
     *
     * @returns False for aborted probes and ordinary failures. Authentication
     * and retryable discovery errors are propagated to the discovery caller.
     */
    async pingModel(modelId: string, options?: DiscoveryProbeOptions): Promise<boolean> {
        try {
            options?.signal.throwIfAborted();
            await this.client.messages.create(
                {
                    model: modelId,
                    messages: [{ role: "user", content: "ping" }],
                    max_tokens: 1,
                },
                { signal: options?.signal, timeout: options?.timeoutMs ?? DISCOVERY_PROBE_TIMEOUT_MS, maxRetries: 0 },
            );
            if (options?.signal.aborted) {
                return false;
            }
            this.logger.log(`    🏓 Anthropic ${modelId} → ✅`);
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
            this.logger.log(`    🏓 Anthropic ${modelId} → ❌`);
            return false;
        }
    }

    /** Estimates tokens locally using the shared heuristic, without an API call. */
    async provideTokenCount(text: string | vscode.LanguageModelChatRequestMessage, _token: vscode.CancellationToken): Promise<number> {
        return estimateTokens(text);
    }

    /**
     * Maps history, restores signed tool turns and streams a Claude response.
     *
     * @remarks
     * Model identity and effort prefer the resolved request. The output budget
     * continues to use the optional catalog spec, falling back to 4096 tokens.
     * An explicit label object, including an empty one, overrides stored labels.
     * Cancellation links the VS Code token with the gateway lifetime signal.
     *
     * @returns Backend usage and the existing character attribution counters.
     * @throws A VS Code cancellation error on abort, or the inference error
     * normalized for gateway transport when applicable.
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
        const client = this.client;
        const replayCache = this.thinkingReplayCache;
        const gateway = this.gateway;
        const cancellation = requestCancellation(token, gateway?.signal);
        const actualId = request?.spec.version ?? spec?.version ?? modelId;
        const effort = request?.effort?.value ?? spec?.effort?.default;
        const requestConfig = effort ? claudeEffortConfig(effort) : undefined;
        this.logger.log(`▶ Anthropic Plugin provideLanguageModelChatResponse called — requested: ${modelId} -> executed: ${actualId}${effort ? ` (${effort} effort)` : ""}, region: ${this.region}, messages: ${messages.length}`);

        const requestLabels = labels || this.labels;
        const requestOptions = { signal: cancellation.signal, ...(Object.keys(requestLabels).length > 0 ? { headers: { "X-Vertex-AI-Labels": Buffer.from(JSON.stringify(requestLabels), "utf8").toString("base64") } } : {}), ...(gateway ? { maxRetries: 0 } : {}) };
        if (Object.keys(requestLabels).length > 0) {
            this.logger.log(`  🏷️  Labels: ${JSON.stringify(requestLabels)}`);
        }

        const maxTokens = spec?.maxOutputTokens ?? 4096;

        try {
            const charCount = { system: 0, user_text: 0, assistant_text: 0, image: 0, tool_use: 0, tool_result: 0 };

            const { systemBlocks, mappedMessages } = mapClaudeMessages(messages, charCount, this.logger);

            const tools = mapClaudeTools(options, charCount);

            const thinkingPrefix = restoreClaudeThinking(actualId, systemBlocks, tools, mappedMessages, this.thinkingReplayCache, this.logger);
            applyClaudeCacheControl(tools, systemBlocks, mappedMessages, this.logger);

            logClaudeMessages(actualId, mappedMessages, systemBlocks, tools, maxTokens, this.logger);

            const stream = await withRetry<any>(
                () =>
                    cancellableRequest(
                        () =>
                            client.messages.create(
                                {
                                    model: actualId,
                                    messages: mappedMessages,
                                    max_tokens: maxTokens,
                                    stream: true,
                                    ...requestConfig,
                                    ...(systemBlocks ? { system: systemBlocks } : {}),
                                    ...(tools?.length ? { tools } : {}),
                                } as any,
                                requestOptions,
                            ),
                        cancellation.signal,
                    ),
                {
                    token: token,
                    ...(gateway ? { maxRetries: 2, maxRetryDurationMs: 60_000, shouldRetry: isGatewayRetryable, retryDelayMs: gatewayRetryDelayMs } : {}),
                },
            );

            this.logger.log(`  Stream created successfully`);

            const usage = await processClaudeStream(stream, charCount, progress, token, replayCache, this.logger, cancellation.signal, thinkingPrefix);
            if (cancellation.signal.aborted) {
                throw new vscode.CancellationError();
            }

            // Report token usage to VS Code (MIME type 'usage') for Copilot Chat indicator
            if (typeof vscode.LanguageModelDataPart !== "undefined") {
                const promptTokens = usage.input;
                const completionTokens = usage.output;
                const cachedTokens = usage.cache_read;

                const usagePayload = {
                    prompt_tokens: promptTokens,
                    completion_tokens: completionTokens,
                    total_tokens: promptTokens + completionTokens,
                    prompt_tokens_details: {
                        cached_tokens: cachedTokens,
                    },
                };

                progress.report(new vscode.LanguageModelDataPart(new TextEncoder().encode(JSON.stringify(usagePayload)), "usage"));
                this.logger.log(`  📊 Reported token usage to VS Code: ${JSON.stringify(usagePayload)}`);
            }

            return { usage, charCount };
        } catch (e: any) {
            if (cancellation.signal.aborted) {
                throw new vscode.CancellationError();
            }
            if (gateway) {
                throw normalizeGatewayError(e);
            }
            this.logger.log(`  ❌ Anthropic provideLanguageModelChatResponse error: ${e}`);
            checkAuthError(e);
            throw e;
        } finally {
            cancellation.dispose();
        }
    }
}
