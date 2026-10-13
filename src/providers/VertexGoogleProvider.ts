import * as vscode from "vscode";
import { Logger } from "../utils/Logger";
import { DISCOVERY_PROBE_TIMEOUT_MS, DiscoveryProbeOptions, getDiscoveryRetryableError } from "../utils/discovery";
import { checkAuthError, withRetry } from "../utils/retry";
import { resolveCatalogModel, type ResolvedModelRequest } from "../effort/Effort";
import { estimateTokens } from "../utils/tokens";
import { ChatInferenceResult, ModelSpec, VertexModelProvider } from "./VertexModelProvider";
import { ProxyGateway, isGatewayRetryable, normalizeGatewayError, gatewayRetryDelayMs } from "../ProxyGateway";
import { requestCancellation, cancellableRequest } from "../utils/cancellation";
import { GeminiMessages, isLeakedReasoningHeader, stripLeakedReasoningHeader } from "./google/GeminiMessages";
import { processGeminiStream } from "./google/GeminiStream";
import { VertexToolSchema } from "./google/VertexToolSchema";

/**
 * Coordinates Gemini client configuration, discovery probes, and streamed inference.
 *
 * @remarks
 * History mapping, stream interpretation, and schema filtering are delegated to
 * {@link GeminiMessages}, {@link processGeminiStream}, and {@link VertexToolSchema}.
 * Provider reinitialization clears signature caches and discards the lazy SDK client.
 */
export class VertexGoogleProvider implements VertexModelProvider {
    vendor = "google";
    private client: any;
    private projectId!: string;
    private region!: string;
    private authOptions?: any;
    private gateway: ProxyGateway | undefined;
    private labels: Record<string, string> = {};
    private readonly logger = new Logger("VertexGoogleProvider");
    /** Tool-call signatures retained by call ID until {@link initialize} clears the map. */
    private readonly thoughtSignatureCache = new Map<string, string>();

    /** IDs supplied by the API, distinguished from local fallback IDs during replay. */
    private readonly apiToolCallIds = new Set<string>();

    /** Text signatures retained by the first 120 answer characters until reinitialization. */
    private readonly textSignatureCache = new Map<string, string>();

    private readonly toolSchema = new VertexToolSchema(this.logger);

    /**
     * Replaces connection options and clears client and signature state.
     *
     * @remarks
     * Direct connections start background schema discovery. The schema allowlist and
     * its discovery completion state survive reinitialization.
     */
    initialize(projectId: string, region: string, authOptions?: any, gateway?: ProxyGateway): void {
        this.projectId = projectId;
        this.region = region;
        this.authOptions = authOptions;
        this.gateway = gateway;
        this.thoughtSignatureCache.clear();
        this.apiToolCallIds.clear();
        this.textSignatureCache.clear();
        // Clear the cached client so it gets re-created with new auth/project options on next use
        this.client = undefined;
        if (!gateway) {
            this.toolSchema.discoverKeys();
        }
    }

    /** Stores the default labels used when a request does not supply its own map. */
    setLabels(labels: Record<string, string>): void {
        this.labels = labels;
    }

    /**
     * Sends a one-token discovery probe with SDK retries restricted to one attempt.
     *
     * @returns False for cancellation or an unavailable model; retryable discovery
     * failures propagate so the dispatcher can apply its discovery retry policy.
     */
    async pingModel(modelId: string, options?: DiscoveryProbeOptions): Promise<boolean> {
        try {
            options?.signal.throwIfAborted();
            const client = await this.getClient();
            options?.signal.throwIfAborted();
            await client.models.generateContent({
                model: modelId,
                contents: [{ role: "user", parts: [{ text: "ping" }] }],
                config: {
                    maxOutputTokens: 1,
                    automaticContinuation: false,
                    abortSignal: options?.signal,
                    httpOptions: { timeout: options?.timeoutMs ?? DISCOVERY_PROBE_TIMEOUT_MS, retryOptions: { attempts: 1 } },
                },
            });
            if (options?.signal.aborted) {
                return false;
            }
            this.logger.log(`    🏓 Google ${modelId} → ✅`);
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
            this.logger.log(`    🏓 Google ${modelId} → ❌ ${e}`);
            return false;
        }
    }

    /** Returns the shared local token estimate without contacting Gemini. */
    async provideTokenCount(text: string | vscode.LanguageModelChatRequestMessage, _token: vscode.CancellationToken): Promise<number> {
        return estimateTokens(text);
    }

    /** Detects the existing model-ID prefix used to filter leaked reasoning text. */
    public isLeakedReasoningHeader(text: string, modelId: string, actualId: string): boolean {
        return isLeakedReasoningHeader(text, modelId, actualId);
    }

    /** Returns the text following the first header newline, or an empty string. */
    public stripLeakedReasoningHeader(text: string): string {
        return stripLeakedReasoningHeader(text);
    }

    /**
     * Maps history, starts the Gemini stream, and reports response parts and usage.
     *
     * @remarks
     * Resolved requests select model identity and effort. The legacy `spec` argument
     * still supplies the output budget. Tool calls are reported together after the
     * stream; answer text is reported incrementally. Tracker input excludes cached
     * tokens, while the VS Code usage part displays the full prompt token count.
     *
     * @throws {@link vscode.CancellationError} when the request is cancelled.
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
        const resolved = request ?? (spec ? resolveCatalogModel(spec) : undefined);
        const actualId = resolved?.spec.version ?? modelId;
        const effort = resolved?.effort?.value ?? spec?.effort?.default;
        const config = effort ? { thinkingConfig: { thinkingLevel: effort.toUpperCase() } } : undefined;
        const gateway = this.gateway;
        const cancellation = requestCancellation(token, gateway?.signal);
        this.logger.log(`▶ Google provideLanguageModelChatResponse called — requested: ${modelId} -> executed: ${actualId}, msgs: ${messages.length}`);

        const requestLabels = labels || this.labels;
        if (Object.keys(requestLabels).length > 0) {
            this.logger.log(`  🏷️  Labels: ${JSON.stringify(requestLabels)}`);
        }
        const charCount = { system: 0, user_text: 0, assistant_text: 0, image: 0, tool_use: 0, tool_result: 0 };
        const cacheCreate = 0;

        try {
            const { mappedContents, systemInstruction } = new GeminiMessages(this.thoughtSignatureCache, this.textSignatureCache, this, this.logger, this.apiToolCallIds).extractMessages(messages, charCount, modelId, actualId);

            const generationConfig: any = { ...config };
            generationConfig.abortSignal = cancellation.signal;
            // Keep one inference stream: SDK continuation can issue additional requests
            // after checkpoints or failures, outside the provider/proxy retry contract.
            generationConfig.automaticContinuation = false;

            if (spec?.maxOutputTokens) {
                generationConfig.maxOutputTokens = spec.maxOutputTokens;
            }

            if (systemInstruction.trim().length > 0) {
                generationConfig.systemInstruction = systemInstruction.trim();
            }

            if (options.tools && options.tools.length > 0) {
                const declarations = options.tools.map((t) => ({
                    name: t.name,
                    description: t.description,
                    parameters: this.toolSchema.sanitize(t.inputSchema || { type: "object", properties: {} }),
                }));
                generationConfig.tools = [{ functionDeclarations: declarations }];
            }

            if (Object.keys(requestLabels).length > 0) {
                generationConfig.labels = requestLabels;
            }

            const client = await this.getClient();
            if (cancellation.signal.aborted) {
                throw new vscode.CancellationError();
            }
            const stream = await withRetry<AsyncIterable<any>>(
                () =>
                    cancellableRequest(
                        () =>
                            client.models.generateContentStream({
                                model: actualId,
                                contents: mappedContents,
                                config: generationConfig,
                            }),
                        cancellation.signal,
                    ),
                {
                    token: token,
                    ...(gateway ? { maxRetries: 2, maxRetryDurationMs: 60_000, shouldRetry: isGatewayRetryable, retryDelayMs: gatewayRetryDelayMs } : {}),
                },
            );

            const { inputTokens, outputTokens, cacheRead } = await processGeminiStream(stream, {
                modelId,
                actualId,
                progress,
                charCount,
                logger: this.logger,
                signal: cancellation.signal,
                thoughtSignatureCache: this.thoughtSignatureCache,
                apiToolCallIds: this.apiToolCallIds,
                textSignatureCache: this.textSignatureCache,
                reasoningHeaders: this,
            });

            // For Gemini, promptTokenCount includes cachedContentTokenCount.
            // To correctly record usage in our tracker, we subtract cached tokens from
            // input tokens so that each category is billed once (standard vs. discounted).
            const newTokens = Math.max(0, inputTokens - cacheRead);

            // Report token usage to VS Code (MIME type 'usage') for Copilot Chat indicator
            if (typeof vscode.LanguageModelDataPart !== "undefined") {
                const usagePayload = {
                    prompt_tokens: inputTokens, // For display we use total prompt tokens
                    completion_tokens: outputTokens,
                    total_tokens: inputTokens + outputTokens,
                    prompt_tokens_details: {
                        cached_tokens: cacheRead,
                    },
                };

                progress.report(new vscode.LanguageModelDataPart(new TextEncoder().encode(JSON.stringify(usagePayload)), "usage"));
                this.logger.log(`  📊 Reported token usage to VS Code: ${JSON.stringify(usagePayload)}`);
            }

            return {
                usage: { input: newTokens, output: outputTokens, cache_read: cacheRead, cache_create: cacheCreate },
                charCount,
            };
        } catch (e: any) {
            if (cancellation.signal.aborted) {
                throw new vscode.CancellationError();
            }
            if (gateway) {
                throw normalizeGatewayError(e);
            }
            this.logger.log(`  ❌ Google provideLanguageModelChatResponse error: ${e}`);
            checkAuthError(e);
            throw e;
        } finally {
            cancellation.dispose();
        }
    }

    /** Lazily imports and constructs the SDK client, rejecting configuration changes during import. */
    private async getClient() {
        if (!this.client) {
            const project = this.projectId,
                location = this.region,
                gateway = this.gateway,
                authOptions = this.authOptions;
            // Use dynamic import to support ESM-only @google/genai in a CommonJS context
            const genai = await import("@google/genai");
            if (project !== this.projectId || location !== this.region || gateway !== this.gateway || authOptions !== this.authOptions) {
                throw new Error("Configuration changed before Google client initialization.");
            }

            this.client = new genai.GoogleGenAI({
                vertexai: true,
                project: this.projectId,
                location: this.region,
                googleAuthOptions: this.gateway ? { authClient: this.gateway.authClient } : this.authOptions,
                // Omitting retryOptions disables SDK retries and preserves HTTP errors.
                ...(this.gateway ? { httpOptions: { baseUrl: this.gateway.url, apiVersion: "v1" } } : {}),
            });
        }
        return this.client;
    }
}
