import { GoogleAuth } from "google-auth-library";
import OpenAI from "openai";
import { Stream } from "openai/streaming";
import * as vscode from "vscode";
import localCatalog from "../models.json";
import { checkAuthError, isRetryableError, withRetry } from "../utils/retry";
import { estimateTokens } from "../utils/tokens";
import type { ModelSpec } from "../VertexChatModelDispatcher";
import type { ChatInferenceResult, VertexModelProvider } from "./VertexModelProvider";

// ─── Output channel for diagnostics ─────────────────────────────────────────

const outputChannel = vscode.window.createOutputChannel("Vertex AI Models: MaaS Provider");

function log(msg: string): void {
  const ts = new Date().toISOString();
  outputChannel.appendLine(`[${ts}] ${msg}`);
}

// ─── Model configuration types ──────────────────────────────────────────────

interface ModelConfig {
  maasPath: string;
  thinking: "none" | "reasoning_content";
  extraBody?: Record<string, unknown>;
}

// ─── Provider Plugin ────────────────────────────────────────────────────────

export class VertexMaaSProvider implements VertexModelProvider {
  vendor = "maas";
  private projectId!: string;
  private region!: string;
  private authOptions?: any;
  private labels: Record<string, string> = {};

  private static readonly MODEL_CONFIG: Record<string, ModelConfig> = {
    "qwen3-coder-480b": {
      maasPath: "qwen/qwen3-coder-480b-a35b-instruct-maas",
      thinking: "none",
    },
    "deepseek-v3.2": {
      maasPath: "deepseek-ai/deepseek-v3.2-maas",
      thinking: "reasoning_content",
      extraBody: { chat_template_kwargs: { thinking: true } },
    },
    "kimi-k2-thinking": {
      maasPath: "moonshotai/kimi-k2-thinking-maas",
      thinking: "reasoning_content",
    },
  };

  // ── Initialization ────────────────────────────────────────────────────

  initialize(projectId: string, region: string, authOptions?: any): void {
    this.projectId = projectId;
    this.region = region;
    this.authOptions = authOptions;
  }

  setLabels(labels: Record<string, string>): void {
    this.labels = labels;
  }

  // ── Client factory (fresh token each call) ────────────────────────────

  private async getClient(): Promise<OpenAI> {
    // Read project ID live from VS Code settings — user may change it anytime
    const projectId = vscode.workspace.getConfiguration("vertexAiChat").get<string>("projectId") || this.projectId;
    const baseURL = this.region === "global" ? `https://aiplatform.googleapis.com/v1/projects/${projectId}/locations/global/endpoints/openapi` : `https://${this.region}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${this.region}/endpoints/openapi`;

    let googleAuth: GoogleAuth;
    if (this.authOptions?.credentials) {
      googleAuth = new GoogleAuth({
        credentials: this.authOptions.credentials,
        scopes: "https://www.googleapis.com/auth/cloud-platform",
      });
    } else if (this.authOptions?.keyFilename) {
      googleAuth = new GoogleAuth({
        keyFilename: this.authOptions.keyFilename,
        scopes: "https://www.googleapis.com/auth/cloud-platform",
      });
    } else {
      googleAuth = new GoogleAuth({
        scopes: "https://www.googleapis.com/auth/cloud-platform",
      });
    }

    const accessToken = await googleAuth.getAccessToken();
    if (!accessToken) {
      throw new Error("Failed to obtain Google Cloud access token");
    }

    log(`  🔑 Fresh token obtained, baseURL=${baseURL}`);
    return new OpenAI({ baseURL, apiKey: accessToken });
  }

  // ── Discovery ping ────────────────────────────────────────────────────

  async pingModel(modelVersion: string): Promise<boolean> {
    // modelVersion from models.json is the MaaS path (e.g. "deepseek-ai/deepseek-v3.2-maas")
    const maasPath = modelVersion;
    try {
      const client = await this.getClient();
      await client.chat.completions.create({
        model: maasPath,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
        stream: false,
      });
      log(`    🏓 MaaS ${maasPath} → ✅`);
      return true;
    } catch (e: any) {
      if (isRetryableError(e)) {
        log(`    🏓 MaaS ${maasPath} → ✅ (rate limited, but available)`);
        return true;
      }
      checkAuthError(e);
      log(`    🏓 MaaS ${maasPath} → ❌ ${e.message || e}`);
      return false;
    }
  }

  // ── Token counting (heuristic) ────────────────────────────────────────

  async provideTokenCount(text: string | vscode.LanguageModelChatRequestMessage, _token: vscode.CancellationToken): Promise<number> {
    return estimateTokens(text);
  }

  // ── Chat response (inference) ─────────────────────────────────────────

  async provideLanguageModelChatResponse(
    modelId: string,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
    labels?: Record<string, string>,
  ): Promise<ChatInferenceResult> {
    const config = VertexMaaSProvider.MODEL_CONFIG[modelId];
    if (!config) {
      throw new Error(`Unknown MaaS model: ${modelId}. Available: ${Object.keys(VertexMaaSProvider.MODEL_CONFIG).join(", ")}`);
    }

    // Look up model spec from the catalog
    const modelSpec = (localCatalog as any).candidateModels.find((m: ModelSpec) => m.id === modelId);
    if (!modelSpec) {
      throw new Error(`Model spec not found in catalog for: ${modelId}`);
    }

    log(`▶ MaaS Plugin provideLanguageModelChatResponse — model: ${modelId} (${config.maasPath}), region: ${this.region}, messages: ${messages.length}, thinking: ${config.thinking}`);

    const requestLabels = labels || this.labels;
    if (Object.keys(requestLabels).length > 0) {
      log(`  🏷️  Labels: ${JSON.stringify(requestLabels)}`);
    }

    try {
      const charCount = { system: 0, user_text: 0, assistant_text: 0, image: 0, tool_use: 0, tool_result: 0 };

      const mappedMessages = this.mapMessages(messages, modelId, options, charCount);
      const tools = this.mapTools(options);

      const client = await this.getClient();

      const requestParams = {
        model: config.maasPath,
        messages: mappedMessages as any,
        temperature: modelSpec.temperature ?? 0.7,
        top_p: modelSpec.top_p ?? 0.9,
        max_tokens: modelSpec.maxOutputTokens ?? 4096,
        stream: true as const,
        ...(tools?.length ? { tools, tool_choice: "auto" as const } : {}),
        ...(config.extraBody ?? {}),
      };
      log(`  📤 Request keys: ${Object.keys(requestParams).join(", ")}`);

      const stream = await withRetry<Stream<OpenAI.Chat.Completions.ChatCompletionChunk>>(() => client.chat.completions.create(requestParams as any) as unknown as Promise<Stream<OpenAI.Chat.Completions.ChatCompletionChunk>>, { log, token });

      log(`  Stream created successfully`);

      const usage = await this.processStream(stream, config, charCount, progress, token);

      // Report token usage to VS Code (MIME type 'usage') for Copilot Chat indicator
      if (typeof vscode.LanguageModelDataPart !== "undefined") {
        const usagePayload = {
          prompt_tokens: usage.input,
          completion_tokens: usage.output,
          total_tokens: usage.input + usage.output,
          prompt_tokens_details: {
            cached_tokens: usage.cache_read,
          },
        };
        progress.report(new vscode.LanguageModelDataPart(new TextEncoder().encode(JSON.stringify(usagePayload)), "usage"));
        log(`  📊 Reported token usage to VS Code: ${JSON.stringify(usagePayload)}`);
      }

      return { usage, charCount };
    } catch (e: any) {
      log(`  ❌ MaaS provideLanguageModelChatResponse error: ${e}`);
      checkAuthError(e);
      throw e;
    }
  }

  // ── Message mapping ───────────────────────────────────────────────────

  private mapMessages(messages: readonly vscode.LanguageModelChatRequestMessage[], modelId: string, options: vscode.ProvideLanguageModelChatResponseOptions, charCount: { system: number; user_text: number; assistant_text: number; image: number; tool_use: number; tool_result: number }): any[] {
    const systemParts: string[] = [];
    const mappedMessages: any[] = [];
    const hasTools = options.tools && options.tools.length > 0;

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const roleNum = msg.role;

      if (roleNum === (0 as vscode.LanguageModelChatMessageRole)) {
        this.extractSystemParts(msg.content, systemParts, charCount);
        continue;
      }

      if (roleNum !== vscode.LanguageModelChatMessageRole.User && roleNum !== vscode.LanguageModelChatMessageRole.Assistant) {
        // Unknown role — treat as system
        this.extractSystemParts(msg.content, systemParts, charCount);
        continue;
      }

      const role = roleNum === vscode.LanguageModelChatMessageRole.User ? "user" : "assistant";
      const isAssistant = role === "assistant";

      // For assistant messages, we handle tool calls and tool results separately
      const textParts: string[] = [];
      const toolCalls: any[] = [];
      const toolResultMessages: any[] = [];

      for (const part of msg.content) {
        if (part instanceof vscode.LanguageModelTextPart) {
          const text = part.value;
          if (isAssistant) {
            textParts.push(text);
            charCount.assistant_text += text.length;
          } else {
            textParts.push(text);
            charCount.user_text += text.length;
          }
        } else if (part instanceof vscode.LanguageModelToolCallPart) {
          toolCalls.push({
            id: part.callId,
            type: "function",
            function: {
              name: part.name,
              arguments: JSON.stringify(part.input),
            },
          });
          charCount.tool_use += JSON.stringify(part.input).length + part.name.length;
        } else if (part instanceof vscode.LanguageModelToolResultPart) {
          // Tool results become separate "tool" messages in OpenAI format
          let toolContent = "";
          if (Array.isArray(part.content)) {
            toolContent = part.content.map((c) => (c instanceof vscode.LanguageModelTextPart ? c.value : JSON.stringify(c))).join("\n");
          } else if (part.content !== undefined && part.content !== null) {
            toolContent = String(part.content);
          }
          toolResultMessages.push({
            role: "tool",
            tool_call_id: part.callId,
            content: toolContent || " ",
          });
          charCount.tool_result += toolContent.length;
        } else if (part instanceof vscode.LanguageModelDataPart) {
          // Silently ignore Anthropic-specific cache_control parts
          if (part.mimeType === "cache_control") {
            continue;
          }
          if (part.mimeType?.startsWith("image/")) {
            const base64 = Buffer.from(part.data).toString("base64");
            textParts.push(`data:${part.mimeType};base64,${base64}`);
            charCount.image += base64.length;
          } else {
            try {
              const text = new TextDecoder().decode(part.data);
              if (text.length > 0) {
                textParts.push(text);
                if (isAssistant) {
                  charCount.assistant_text += text.length;
                } else {
                  charCount.user_text += text.length;
                }
                log(`     📎 Mapped non-image DataPart (${part.mimeType}) as text (${text.length} chars)`);
              }
            } catch {
              log(`     ⚠️  Skipped non-image DataPart (${part.mimeType}) — could not decode`);
            }
          }
        }
      }

      // Build the OpenAI-format message
      const hasText = textParts.length > 0;
      const hasToolCalls = toolCalls.length > 0;

      if (hasText || hasToolCalls) {
        const entry: any = { role };
        // Check if any textPart is an object (image_url) — images need array format
        const hasImageParts = textParts.some((t) => typeof t !== "string");
        if (hasText) {
          entry.content = hasImageParts || !isAssistant ? textParts.map((t) => (typeof t === "string" ? { type: "text", text: t } : t)) : textParts.join("\n");
        }
        if (hasToolCalls) {
          entry.tool_calls = toolCalls;
        }
        mappedMessages.push(entry);
      }

      // Append tool result messages after the assistant message
      for (const tr of toolResultMessages) {
        mappedMessages.push(tr);
      }
    }

    // Prepend system message (unless DeepSeek with tools — see rule below)
    const config = VertexMaaSProvider.MODEL_CONFIG[modelId];
    const isDeepseek = config?.maasPath?.startsWith("deepseek-ai/");
    if (systemParts.length > 0 && !(isDeepseek && hasTools)) {
      const systemText = systemParts.join("\n");
      mappedMessages.unshift({ role: "system", content: systemText });
    } else if (isDeepseek && hasTools && systemParts.length > 0) {
      log(`  ⚠️  Omitting system prompt for DeepSeek model with tools (per GCP MaaS guidance)`);
    }

    // Ensure first message is user
    if (mappedMessages.length === 0 || mappedMessages[0].role !== "user") {
      log(`  ⚠️  No user messages — inserting placeholder`);
      mappedMessages.unshift({ role: "user", content: [{ type: "text", text: " " }] });
    }

    return mappedMessages;
  }

  private extractSystemParts(content: readonly vscode.LanguageModelChatRequestMessage["content"][number][], systemParts: string[], charCount: { system: number }): void {
    for (const part of content) {
      if (part instanceof vscode.LanguageModelTextPart && part.value.length > 0) {
        systemParts.push(part.value);
        charCount.system += part.value.length;
      }
    }
  }

  // ── Tool schema mapping ───────────────────────────────────────────────

  private mapTools(options: vscode.ProvideLanguageModelChatResponseOptions): any[] | undefined {
    if (!options.tools?.length) {
      return undefined;
    }

    return options.tools.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema ?? { type: "object", properties: {} },
      },
    }));
  }

  // ── Logging helpers ───────────────────────────────────────────────────

  // ── Stream processing ─────────────────────────────────────────────────

  private async processStream(
    stream: Stream<OpenAI.Chat.Completions.ChatCompletionChunk>,
    config: ModelConfig,
    charCount: { assistant_text: number; tool_use: number },
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<{ input: number; output: number; cache_read: number; cache_create: number }> {
    // Accumulate tool call deltas (OpenAI streams tool calls incrementally)
    const toolAccumulator: Map<number, { id: string; name: string; json: string }> = new Map();
    const tokenUsage = { input: 0, output: 0, cache_read: 0, cache_create: 0 };
    let chunkCount = 0;

    for await (const chunk of stream) {
      chunkCount++;
      if (token.isCancellationRequested) {
        log(`  Cancelled after ${chunkCount} chunks`);
        break;
      }

      // Extract usage if present
      if (chunk.usage) {
        tokenUsage.input = chunk.usage.prompt_tokens ?? 0;
        tokenUsage.output = chunk.usage.completion_tokens ?? 0;
        // MaaS doesn't report cached tokens separately, but try anyway
        const details = (chunk.usage as any).prompt_tokens_details;
        if (details?.cached_tokens) {
          tokenUsage.cache_read = details.cached_tokens;
        }
      }

      const delta = chunk.choices?.[0]?.delta;
      if (!delta) {
        continue;
      }

      // Access reasoning_content — this is a MaaS-specific field not in the OpenAI SDK types
      const reasoningContent = (delta as Record<string, unknown>)["reasoning_content"] as string | undefined;
      const content = delta.content as string | undefined;

      if (config.thinking === "reasoning_content" && reasoningContent) {
        // Silently consume thinking tokens; counted in completion_tokens by MaaS
      }

      if (content) {
        charCount.assistant_text += content.length;
        progress.report(new vscode.LanguageModelTextPart(content));
      }

      // Handle tool call deltas
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index;
          if (!toolAccumulator.has(idx)) {
            toolAccumulator.set(idx, { id: tc.id ?? "", name: "", json: "" });
          }
          const acc = toolAccumulator.get(idx)!;
          if (tc.id) {
            acc.id = tc.id;
          }
          if (tc.function?.name) {
            acc.name = tc.function.name;
          }
          if (tc.function?.arguments) {
            acc.json += tc.function.arguments;
          }
        }
      }

      // Check finish_reason — when the model finishes, emit any complete tool calls
      const finishReason = chunk.choices?.[0]?.finish_reason;
      if (finishReason) {
        for (const [, acc] of toolAccumulator) {
          if (acc.name && acc.json) {
            let parsedInput = {};
            try {
              parsedInput = JSON.parse(acc.json);
            } catch {
              // Partial JSON at stream end — still emit what we have
              log(`  ⚠️  Incomplete tool call JSON for ${acc.name}: ${acc.json.slice(0, 200)}`);
            }
            charCount.tool_use += acc.json.length + acc.name.length;
            progress.report(new vscode.LanguageModelToolCallPart(acc.id, acc.name, parsedInput));
            log(`  🔧 Tool call emitted: ${acc.name}(${acc.json.slice(0, 100)}…)`);
          }
        }
        toolAccumulator.clear();
      }
    }

    // If stream ended without usage (e.g., cancelled), try to get final usage
    if (tokenUsage.input === 0 && tokenUsage.output === 0) {
      try {
        // ChatCompletionStream (openai/lib/ChatCompletionStream) has finalChatCompletion(),
        // but the raw Stream<ChatCompletionChunk> from openai/streaming does not.
        const s = stream as any;
        if (typeof s.finalChatCompletion === "function") {
          const completion = await s.finalChatCompletion();
          if (completion.usage) {
            tokenUsage.input = completion.usage.prompt_tokens ?? 0;
            tokenUsage.output = completion.usage.completion_tokens ?? 0;
          }
        } else {
          log(`  ⚠️  Stream type does not support finalChatCompletion — usage may be incomplete`);
        }
      } catch {
        // finalChatCompletion may throw if stream was interrupted
        log(`  ⚠️  Could not retrieve final chat completion for usage`);
      }
    }

    log(`  ✅ Stream finished — ${chunkCount} chunks total, input=${tokenUsage.input}, output=${tokenUsage.output}`);
    return tokenUsage;
  }
}
