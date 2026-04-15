import * as vscode from "vscode";
import { isRetryableError, withRetry } from "../utils/retry";
import { ChatInferenceResult, VertexModelProvider } from "./VertexModelProvider";

const outputChannel = vscode.window.createOutputChannel("Vertex AI Models: Google Provider");

function log(msg: string): void {
  const ts = new Date().toISOString();
  outputChannel.appendLine(`[${ts}] ${msg}`);
}

export class VertexGoogleProvider implements VertexModelProvider {
  vendor = "google";
  private client: any;
  private projectId!: string;
  private region!: string;
  /**
   * Cache of thought signatures keyed by unique tool call ID.
   * Gemini 3 embeds the thought_signature inline on the functionCall part;
   * we cache it here so it can be re-injected when VS Code replays history.
   * Unbounded: entries are only looked up while they appear in VS Code's
   * conversation history window, so growth is naturally bounded by context size.
   */
  private readonly thoughtSignatureCache = new Map<string, string>();

  /**
   * Cache of thought signatures for non-functionCall (text) parts.
   * Keyed by the first 120 chars of the text content — enough to be unique
   * in practice. Replaying these is optional (no 400 error if omitted) but
   * recommended for best reasoning quality across turns.
   */
  private readonly textSignatureCache = new Map<string, string>();

  initialize(projectId: string, region: string): void {
    this.projectId = projectId;
    this.region = region;
  }

  private async getClient() {
    if (!this.client) {
      // Use dynamic import to support ESM-only @google/genai in a CommonJS context
      const genai = await import("@google/genai");

      this.client = new genai.GoogleGenAI({
        // @ts-ignore - type definition restricts vertexai to boolean, but project/location are top-level
        vertexai: true,
        project: this.projectId,
        location: this.region,
      });
    }
    return this.client;
  }

  /**
   * Evaluates the VS Code model ID and returns the actual Endpoint name and thinking parameters
   */
  private resolveModelId(modelId: string): { actualId: string; config?: any } {
    if (modelId.endsWith("-high")) {
      return { actualId: modelId.replace("-high", ""), config: { thinkingConfig: { thinkingLevel: "HIGH" } } };
    }
    return { actualId: modelId };
  }

  async pingModel(modelId: string): Promise<boolean> {
    const { actualId } = this.resolveModelId(modelId);
    try {
      const client = await this.getClient();
      await client.models.generateContent({
        model: actualId,
        contents: "ping",
        config: { maxOutputTokens: 1 },
      });
      log(`    🏓 Google ${modelId} -> ${actualId} → ✅`);
      return true;
    } catch (e: any) {
      if (isRetryableError(e)) {
        log(`    🏓 Google ${modelId} -> ${actualId} → ✅ (rate limited, but available)`);
        return true;
      }
      log(`    🏓 Google ${modelId} -> ${actualId} → ❌ ${e}`);
      return false;
    }
  }

  async provideTokenCount(text: string | vscode.LanguageModelChatRequestMessage, _token: vscode.CancellationToken): Promise<number> {
    if (typeof text === "string") {
      return Math.ceil(text.length / 4);
    }
    let length = 0;
    for (const part of text.content) {
      if (part instanceof vscode.LanguageModelTextPart) {
        length += part.value.length;
      }
    }
    return Math.ceil(length / 4);
  }

  private mapRole(roleNum: number): string {
    if (roleNum === vscode.LanguageModelChatMessageRole.User) {
      return "user";
    }
    if (roleNum === vscode.LanguageModelChatMessageRole.Assistant) {
      return "model";
    }
    return "system";
  }

  private mapToolResult(p: vscode.LanguageModelToolResultPart, callName?: string): any {
    let resStr = "{}";
    if (Array.isArray(p.content)) {
      resStr = p.content
        .map((c) => {
          if (c instanceof vscode.LanguageModelTextPart) {
            return c.value;
          }
          return JSON.stringify(c);
        })
        .join("\n");
    } else {
      resStr = String(p.content);
    }

    // Use the function name for the response name field (Gemini requires the
    // actual function name, not a unique call ID). Fall back to callId if name
    // is not available (e.g. non-thinking models where callId === name).
    const responseName = callName ?? p.callId;
    try {
      const parsed = JSON.parse(resStr);
      // Gemini expects 'response' to be a google.protobuf.Struct, which is a JSON object (map).
      // If the parsed JSON is not a plain object (e.g. it's a string, number, or array),
      // we must wrap it in an object to satisfy the Struct requirement.
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return { functionResponse: { name: responseName, response: parsed } };
      }
    } catch {
      // ignore
    }
    return { functionResponse: { name: responseName, response: { result: resStr } } };
  }

  private extractMessages(messages: readonly vscode.LanguageModelChatRequestMessage[], charCount: any): { mappedContents: any[]; systemInstruction: string } {
    const mappedContents: any[] = [];
    let systemInstruction = "";
    // Build a map from callId -> function name so tool results can use the right name
    const callIdToName = new Map<string, string>();

    for (const msg of messages) {
      const roleName = this.mapRole(msg.role);

      if (roleName === "system") {
        for (const p of msg.content) {
          if (p instanceof vscode.LanguageModelTextPart) {
            systemInstruction += p.value + "\n";
            charCount.system += p.value.length;
          }
        }
        continue; // System instructions are passed separately in Gemini
      }

      const parts: any[] = [];
      for (const p of msg.content) {
        if (p instanceof vscode.LanguageModelTextPart) {
          if (p.value.length > 0) {
            // For assistant text parts, re-attach any cached thought signature.
            // The docs recommend (but don't require) echoing these back to
            // preserve reasoning quality across turns.
            if (roleName === "model") {
              const textKey = p.value.substring(0, 120);
              const cachedTextSig = this.textSignatureCache.get(textKey);
              if (cachedTextSig) {
                parts.push({ text: p.value, thoughtSignature: cachedTextSig });
                log(`  📋 Text part in history: re-attached thought signature (${cachedTextSig.length} chars)`);
              } else {
                parts.push({ text: p.value });
              }
            } else {
              parts.push({ text: p.value });
            }
            if (roleName === "user") {
              charCount.user_text += p.value.length;
            } else {
              charCount.assistant_text += p.value.length;
            }
          }
        } else if (p instanceof vscode.LanguageModelToolCallPart) {
          // Track callId -> function name for tool result mapping below.
          callIdToName.set(p.callId, p.name);
          const cachedSig = this.thoughtSignatureCache.get(p.callId);
          log(`  📋 ToolCall in history: callId=${p.callId} name=${p.name} hasCachedSig=${!!cachedSig} cacheSize=${this.thoughtSignatureCache.size}`);
          if (cachedSig) {
            // Gemini 3: embed the thought_signature inline on the functionCall part
            // (exactly as the API returned it). Also works for Gemini 2.x which
            // accepts either the inline or the preceding-thought-part form.
            parts.push({ functionCall: { name: p.name, args: p.input }, thoughtSignature: cachedSig });
            log(`    ↪ injected inline thought signature on functionCall part (${cachedSig.length} chars)`);
          } else {
            log(`    ⚠️  NO thought signature found for callId=${p.callId}`);
            parts.push({ functionCall: { name: p.name, args: p.input } });
          }
          charCount.tool_use += JSON.stringify(p.input).length + p.name.length;
        } else if (p instanceof vscode.LanguageModelToolResultPart) {
          const resolvedName = callIdToName.get(p.callId);
          log(`  📋 ToolResult in history: callId=${p.callId} resolvedName=${resolvedName ?? "(not found, using callId)"}`);
          parts.push(this.mapToolResult(p, resolvedName));
          charCount.tool_result += 1;
        } else if (p instanceof vscode.LanguageModelDataPart) {
          if (p.mimeType?.startsWith("image/")) {
            parts.push({
              inlineData: { mimeType: p.mimeType, data: Buffer.from(p.data).toString("base64") },
            });
            charCount.image += p.data.byteLength;
          } else {
            try {
              const text = new TextDecoder().decode(p.data);
              if (text.length > 0) {
                parts.push({ text });
              }
            } catch (e) {
              // ignore unparseable data part
              log(`⚠️  Unparseable data part: ${e}`);
            }
          }
        }
      }

      if (parts.length > 0) {
        mappedContents.push({ role: roleName, parts });
      } else {
        mappedContents.push({ role: roleName, parts: [{ text: " " }] });
      }
    }

    // Merge consecutive user messages that contain only functionResponse parts
    // into a single user message. This is required by the Gemini API for parallel
    // tool calls: all function responses must be in one user turn, not interleaved
    // across multiple user messages (which VS Code sends one per tool result).
    const merged: any[] = [];
    for (const content of mappedContents) {
      const prev = merged.at(-1);
      const isFunctionResponseOnly = (c: any) => c.role === "user" && c.parts.every((p: any) => p.functionResponse !== undefined);
      if (prev && isFunctionResponseOnly(prev) && isFunctionResponseOnly(content)) {
        // Merge into the previous user message
        prev.parts.push(...content.parts);
      } else {
        merged.push(content);
      }
    }

    // Make sure first non-system message is from user
    if (merged.length === 0 || merged[0].role !== "user") {
      merged.unshift({ role: "user", parts: [{ text: " " }] });
    }

    return { mappedContents: merged, systemInstruction };
  }

  async provideLanguageModelChatResponse(
    modelId: string,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<ChatInferenceResult> {
    const { actualId, config } = this.resolveModelId(modelId);
    log(`▶ Google provideLanguageModelChatResponse called — requested: ${modelId} -> executed: ${actualId}, msgs: ${messages.length}`);

    const charCount = { system: 0, user_text: 0, assistant_text: 0, image: 0, tool_use: 0, tool_result: 0 };
    let inputTokens = 0,
      outputTokens = 0,
      cacheRead = 0,
      cacheCreate = 0;

    try {
      const { mappedContents, systemInstruction } = this.extractMessages(messages, charCount);

      const generationConfig: any = { ...config };

      if (systemInstruction.trim().length > 0) {
        generationConfig.systemInstruction = systemInstruction.trim();
      }

      if (options.tools && options.tools.length > 0) {
        // Define a Set of known unsupported keys for O(1) lookups
        const UNSUPPORTED_KEYS = new Set(["enumDescriptions", "examples"]);

        const sanitizeSchemaForVertex = (schema: any): any => {
          if (!schema || typeof schema !== "object") {
            return schema;
          }
          if (Array.isArray(schema)) {
            return schema.map(sanitizeSchemaForVertex);
          }

          const result: any = {};
          for (const [key, value] of Object.entries(schema)) {
            // Strip any key that Vertex rejects
            if (UNSUPPORTED_KEYS.has(key)) {
              continue;
            }
            result[key] = sanitizeSchemaForVertex(value);
          }
          return result;
        };

        const declarations = options.tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: sanitizeSchemaForVertex(t.inputSchema || { type: "object", properties: {} }),
        }));
        generationConfig.tools = [{ functionDeclarations: declarations }];
        log(`  🔧 Provided ${declarations.length} tools: ${declarations.map((d) => d.name).join(", ")}`);
      }

      const client = await this.getClient();
      const stream = await withRetry(
        () =>
          client.models.generateContentStream({
            model: actualId,
            contents: mappedContents,
            config: generationConfig,
          }),
        {
          log: log,
          token: token,
        },
      );

      // Buffer all function calls across the entire stream before emitting any.
      // Parallel tool calls (e.g. FC1+sig, FC2) can arrive in separate chunks;
      // emitting them incrementally causes VS Code to treat them as separate
      // model steps, which the API then rejects ("number of function response
      // parts must equal number of function call parts"). Buffering and emitting
      // all calls together after stream end groups them into one model turn.
      let pendingThoughtSignature: string | undefined;
      const bufferedCalls: Array<{ callId: string; callName: string; args: any; signature?: string }> = [];

      for await (const chunk of stream) {
        if (token.isCancellationRequested) {
          break;
        }

        // Build a name->signature map from raw parts for this chunk.
        // Gemini 3: signature is inline on the functionCall part.
        // Gemini 2.x thinking: signature is on a preceding { thought: true } part.
        const rawParts: any[] | undefined = chunk.candidates?.[0]?.content?.parts;
        const inlineSignatureByName = new Map<string, string>();

        if (rawParts) {
          log(
            `  🧩 Chunk rawParts[${rawParts.length}]: ${rawParts
              .map((p: any) => {
                if (p.thought) {
                  return `thought(sig=${!!p.thoughtSignature},len=${p.thoughtSignature?.length ?? 0})`;
                }
                if (p.functionCall) {
                  return `functionCall(${p.functionCall.name},inlineSig=${!!p.thoughtSignature})`;
                }
                if (p.functionResponse) {
                  return `functionResponse(${p.functionResponse.name})`;
                }
                if (p.text !== undefined) {
                  return `text(${p.text.length},sig=${!!p.thoughtSignature})`;
                }
                return JSON.stringify(Object.keys(p));
              })
              .join(", ")}`,
          );
          for (const part of rawParts) {
            // Legacy: separate thought part with signature (Gemini 2.x thinking)
            if (part.thought === true && part.thoughtSignature) {
              pendingThoughtSignature = part.thoughtSignature;
              log(`    ✍️  Captured preceding thought signature (${part.thoughtSignature.length} chars)`);
            }
            // Gemini 3: signature embedded directly on the functionCall part
            if (part.functionCall?.name && part.thoughtSignature) {
              inlineSignatureByName.set(part.functionCall.name, part.thoughtSignature);
              log(`    ✍️  Captured inline thought signature for ${part.functionCall.name} (${part.thoughtSignature.length} chars)`);
            }
            // Capture optional signature on final text parts (non-functionCall turns)
            if (part.text !== undefined && part.thoughtSignature && !part.thought) {
              const textKey = part.text.substring(0, 120);
              if (textKey.length > 0) {
                this.textSignatureCache.set(textKey, part.thoughtSignature);
                log(`    📝 Cached text thought signature for key "${textKey.substring(0, 40)}..." (${part.thoughtSignature.length} chars)`);
              }
            }
          }
        }

        const functionCalls = chunk.functionCalls;
        if (functionCalls && functionCalls.length > 0) {
          for (const fc of functionCalls) {
            const callName = fc.name || "unknown";
            const callId = `${callName}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
            const signature = inlineSignatureByName.get(callName) ?? pendingThoughtSignature;
            log(`  🔧 FunctionCall buffered: name=${callName} callId=${callId} inlineSig=${inlineSignatureByName.has(callName)} pendingSig=${!!pendingThoughtSignature}`);
            bufferedCalls.push({ callId, callName, args: fc.args ?? {}, signature });
          }
          // Clear the pending (legacy) signature after processing all calls in this chunk.
          pendingThoughtSignature = undefined;
        }

        if (chunk.text) {
          charCount.assistant_text += chunk.text.length;
          progress.report(new vscode.LanguageModelTextPart(chunk.text));
        }

        if (chunk.usageMetadata) {
          inputTokens = chunk.usageMetadata.promptTokenCount ?? inputTokens;
          outputTokens = chunk.usageMetadata.candidatesTokenCount ?? outputTokens;
          cacheRead = chunk.usageMetadata.cachedContentTokenCount ?? cacheRead;
        }
      }

      // Emit all buffered function calls together so VS Code groups them into
      // a single model turn, matching the API's parallel-call expectations.
      if (bufferedCalls.length > 0) {
        log(`  🔧 Emitting ${bufferedCalls.length} buffered function call(s)`);
        for (const { callId, callName, args, signature } of bufferedCalls) {
          if (signature) {
            this.thoughtSignatureCache.set(callId, signature);
            log(`    💾 Cached thought signature for callId=${callId} (${signature.length} chars)`);
          } else {
            log(`    ⚠️  No thought signature for callId=${callId}`);
          }
          progress.report(new vscode.LanguageModelToolCallPart(callId, callName, args));
        }
      }

      log(`  ✅ Stream finished successfully`);

      // For Gemini, promptTokenCount includes cachedContentTokenCount.
      // To correctly record usage in our tracker, we subtract cached tokens from
      // input tokens so that each category is billed once (standard vs. discounted).
      const newTokens = Math.max(0, inputTokens - cacheRead);

      return {
        usage: { input: newTokens, output: outputTokens, cache_read: cacheRead, cache_create: cacheCreate },
        charCount,
      };
    } catch (e) {
      log(`  ❌ Google provideLanguageModelChatResponse error: ${e}`);
      throw e;
    }
  }
}
