import * as https from "https";
import * as vscode from "vscode";
import { Logger } from "../utils/Logger";
import { checkAuthError, isRetryableError, withRetry } from "../utils/retry";
import { estimateTokens } from "../utils/tokens";
import { ChatInferenceResult, ModelSpec, VertexModelProvider } from "./VertexModelProvider";

export class VertexGoogleProvider implements VertexModelProvider {
  vendor = "google";
  private client: any;
  private projectId!: string;
  private region!: string;
  private authOptions?: any;
  private labels: Record<string, string> = {};
  private readonly logger = new Logger("VertexGoogleProvider");
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

  // Safe minimal start list for JSON schema properties supported by Google Cloud AI.
  private allowedSchemaKeys = new Set<string>(["type", "format", "description", "nullable", "enum", "properties", "required", "items"]);
  private discoveryCompleted = false;

  private discoverVertexSchemaKeys() {
    if (this.discoveryCompleted) {
      return;
    }
    const url = "https://aiplatform.googleapis.com/$discovery/rest?version=v1";
    https
      .get(url, (response) => {
        if (response.statusCode !== 200) {
          return;
        }
        let data = "";
        response.on("data", (chunk) => (data += chunk));
        response.on("end", () => {
          try {
            const doc = JSON.parse(data);
            const schemaDef = doc.schemas?.GoogleCloudAiplatformV1Schema;
            if (schemaDef?.properties) {
              const keys = Object.keys(schemaDef.properties);
              if (keys.length > 0) {
                this.allowedSchemaKeys = new Set(keys);
                this.discoveryCompleted = true;
                this.logger.log(`🌐 Vertex Schema Discovery completed: populated ${keys.length} allowed properties. ${JSON.stringify(keys)}`);
              }
            }
          } catch (e) {
            this.logger.log(`⚠️ Vertex Schema Discovery parse error, falling back to safe list: ${e}`);
          }
        });
      })
      .on("error", (e) => {
        this.logger.log(`⚠️ Vertex Schema Discovery network error, falling back to safe list: ${e}`);
      });
  }

  initialize(projectId: string, region: string, authOptions?: any): void {
    this.projectId = projectId;
    this.region = region;
    this.authOptions = authOptions;
    // Clear the cached client so it gets re-created with new auth/project options on next use
    this.client = undefined;
    this.discoverVertexSchemaKeys();
  }

  setLabels(labels: Record<string, string>): void {
    this.labels = labels;
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
        googleAuthOptions: this.authOptions,
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
        contents: [{ role: "user", parts: [{ text: "ping" }] }],
        config: {
          maxOutputTokens: 1,
        },
      });
      this.logger.log(`    🏓 Google ${modelId} -> ${actualId} → ✅`);
      return true;
    } catch (e: any) {
      if (isRetryableError(e)) {
        this.logger.log(`    🏓 Google ${modelId} -> ${actualId} → ✅ (rate limited, but available)`);
        return true;
      }
      checkAuthError(e);
      this.logger.log(`    🏓 Google ${modelId} -> ${actualId} → ❌ ${e}`);
      return false;
    }
  }

  async provideTokenCount(text: string | vscode.LanguageModelChatRequestMessage, _token: vscode.CancellationToken): Promise<number> {
    return estimateTokens(text);
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

  /**
   * Detects if the given text segment is the starting chunk of a leaked reasoning block
   * (e.g. `gemini-3.5-flash-high\5R+S41tN...`).
   *
   * @param text The text chunk/part to inspect.
   * @param modelId The configured/requested VS Code model ID.
   * @param actualId The actual resolved Vertex AI model/endpoint ID.
   * @returns `true` if the text starts with the leaked reasoning signature prefix; otherwise `false`.
   */
  public isLeakedReasoningHeader(text: string, modelId: string, actualId: string): boolean {
    const trimmed = text.trimStart();
    return trimmed.startsWith(modelId + "\\") || trimmed.startsWith(actualId + "\\") || trimmed.startsWith(modelId + "/") || trimmed.startsWith(actualId + "/");
  }

  /**
   * Strips the leaked signature prefix from a reasoning header text block, returning only
   * the clean answer text following the first newline.
   *
   * @param text The dirty text containing the leaked reasoning header prefix.
   * @returns The remaining text after the prefix block (i.e. everything after the first newline),
   *          or an empty string if there is no newline (meaning the block is purely signature metadata).
   */
  public stripLeakedReasoningHeader(text: string): string {
    const firstNewline = text.indexOf("\n");
    if (firstNewline !== -1) {
      return text.substring(firstNewline + 1);
    }
    return "";
  }

  /**
   * Maps a single VS Code `LanguageModelChatRequestMessage` to its respective raw parts array
   * as expected by the Google Gen AI / Vertex AI API, while sanitizing leaked reasoning history
   * and injecting cached thought signatures to preserve reasoning chain quality.
   *
   * @param msg The source VS Code message to map.
   * @param roleName The role of the message sender ("user", "model", "system").
   * @param modelId The configured/requested VS Code model ID.
   * @param actualId The actual resolved Vertex AI model/endpoint ID.
   * @param charCount The running character count analytics object.
   * @param callIdToName A map tracking tool call IDs to their original function names.
   * @returns An array of mapped content parts conformant to Vertex AI schema requirements.
   */
  private mapMessageParts(msg: vscode.LanguageModelChatRequestMessage, roleName: string, modelId: string, actualId: string, charCount: any, callIdToName: Map<string, string>): any[] {
    const parts: any[] = [];
    for (const p of msg.content) {
      if (p instanceof vscode.LanguageModelTextPart) {
        if (p.value.length > 0) {
          let cleanText = p.value;
          if (roleName === "model" && this.isLeakedReasoningHeader(cleanText, modelId, actualId)) {
            const stripped = this.stripLeakedReasoningHeader(cleanText);
            if (stripped.length > 0) {
              cleanText = stripped;
              this.logger.log(`  🧹 Stripped leaked reasoning header from model turn in history`);
            } else {
              cleanText = "";
              this.logger.log(`  🧹 Stripped entire leaked reasoning model turn in history`);
            }
          }

          if (roleName === "model") {
            const textKey = cleanText.substring(0, 120);
            const cachedTextSig = this.textSignatureCache.get(textKey);
            if (cachedTextSig) {
              parts.push({ text: cleanText, thoughtSignature: cachedTextSig });
              this.logger.log(`  📋 Text part in history: re-attached thought signature (${cachedTextSig.length} chars)`);
            } else {
              parts.push({ text: cleanText });
            }
          } else {
            parts.push({ text: cleanText });
          }

          if (roleName === "user") {
            charCount.user_text += cleanText.length;
          } else {
            charCount.assistant_text += cleanText.length;
          }
        }
      } else if (p instanceof vscode.LanguageModelToolCallPart) {
        callIdToName.set(p.callId, p.name);
        const cachedSig = this.thoughtSignatureCache.get(p.callId);
        this.logger.log(`  📋 ToolCall in history: callId=${p.callId} name=${p.name} hasCachedSig=${!!cachedSig} cacheSize=${this.thoughtSignatureCache.size}`);
        if (cachedSig) {
          parts.push({ functionCall: { name: p.name, args: p.input }, thoughtSignature: cachedSig });
          this.logger.log(`    ↪ injected inline thought signature on functionCall part (${cachedSig.length} chars)`);
        } else {
          this.logger.log(`    ⚠️  NO thought signature found for callId=${p.callId}`);
          parts.push({ functionCall: { name: p.name, args: p.input } });
        }
        charCount.tool_use += JSON.stringify(p.input).length + p.name.length;
      } else if (p instanceof vscode.LanguageModelToolResultPart) {
        const resolvedName = callIdToName.get(p.callId);
        this.logger.log(`  📋 ToolResult in history: callId=${p.callId} resolvedName=${resolvedName ?? "(not found, using callId)"}`);
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
            this.logger.log(`⚠️  Unparseable data part: ${e}`);
          }
        }
      }
    }
    return parts;
  }

  /**
   * Merges consecutive user-role messages containing only functionResponse parts into a single turn.
   * This is a critical requirement of the Gemini parallel tool-calling protocol, which demands
   * that all tool execution responses from a single model turn are delivered together in one user turn.
   *
   * @param mappedContents The list of mapped roles and parts.
   * @returns A merged list of messages with parallel tool calls consolidated.
   */
  private mergeParallelToolResponses(mappedContents: any[]): any[] {
    const merged: any[] = [];
    for (const content of mappedContents) {
      const prev = merged.at(-1);
      const isFunctionResponseOnly = (c: any) => c.role === "user" && c.parts.every((p: any) => p.functionResponse !== undefined);
      if (prev && isFunctionResponseOnly(prev) && isFunctionResponseOnly(content)) {
        prev.parts.push(...content.parts);
      } else {
        merged.push(content);
      }
    }
    return merged;
  }

  /**
   * Extracts system instructions and translates conversation history from the standard VS Code
   * Language Model API format into the exact payload structure expected by Google Vertex AI,
   * applying proactive reasoning header sanitization and parallel tool consolidate filters.
   *
   * @param messages The standard readonly VS Code message list representing the active chat history.
   * @param charCount The running character count analytics object.
   * @param modelId The configured/requested VS Code model ID.
   * @param actualId The actual resolved Vertex AI model/endpoint ID.
   * @returns An object containing mapped content structures and the isolated system instruction.
   */
  private extractMessages(messages: readonly vscode.LanguageModelChatRequestMessage[], charCount: any, modelId: string, actualId: string): { mappedContents: any[]; systemInstruction: string } {
    const mappedContents: any[] = [];
    let systemInstruction = "";
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
        continue;
      }

      const parts = this.mapMessageParts(msg, roleName, modelId, actualId, charCount, callIdToName);

      if (parts.length > 0) {
        mappedContents.push({ role: roleName, parts });
      } else {
        mappedContents.push({ role: roleName, parts: [{ text: " " }] });
      }
    }

    const merged = this.mergeParallelToolResponses(mappedContents);

    if (merged.length === 0 || merged[0].role !== "user") {
      merged.unshift({ role: "user", parts: [{ text: " " }] });
    }

    return { mappedContents: merged, systemInstruction };
  }

  /**
   * Sanitizes a dynamic JSON schema to strictly conform to Vertex AI's OpenAPI 3.0 requirements.
   * Vertex AI tightly validates tool schemas. If tools contain arbitrary or non-standard metadata keys
   * (such as \`$comment\` from Playwright, or \`enumDescriptions\`), the generation request will crash
   * with a \`400 INVALID_ARGUMENT\` response.
   *
   * This function acts as a deep-recursive positive filter. It only preserves schema properties that
   * explicitly exist in \`this.allowedSchemaKeys\`.
   *
   * @param schema The raw arbitrary JSON schema object.
   * @param isPropertiesMap Internal flag indicating if the current depth is inside a schema's \`properties\`
   *        object. Since the keys of a \`properties\` object represent argument names (not schema keywords),
   *        they are preserved as-is.
   * @returns A sanitized schema safe for Vertex AI \`generateContent\` payloads.
   *
   * @example
   * ```json
   * // Input schema payload with arbitrary/invalid metadata
   * {
   *   "type": "object",
   *   "properties": {
   *     "pageId": { "type": "string", "$comment": "A comment to strip" }
   *   },
   *   "required": ["pageId"]
   * }
   *
   * // Sanitized output (safe for Vertex AI)
   * {
   *   "type": "object",
   *   "properties": {
   *     "pageId": { "type": "string" }
   *   },
   *   "required": ["pageId"]
   * }
   * ```
   */
  private sanitizeSchemaForVertex(schema: any, isPropertiesMap = false): any {
    if (!schema || typeof schema !== "object") {
      return schema;
    }
    if (Array.isArray(schema)) {
      return schema.map((item) => this.sanitizeSchemaForVertex(item));
    }

    const result: any = {};
    for (const [key, value] of Object.entries(schema)) {
      if (isPropertiesMap) {
        // The keys here are tool argument names, keep them as is and sanitize their schemas
        result[key] = this.sanitizeSchemaForVertex(value, false);
      } else {
        // Only strictly allow keys natively supported by Google's API Open API 3.0 schema representation
        if (this.allowedSchemaKeys.has(key)) {
          result[key] = this.sanitizeSchemaForVertex(value, key === "properties");
        }
      }
    }
    return result;
  }

  private logRawParts(rawParts: any[]): void {
    this.logger.log(
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
  }

  async provideLanguageModelChatResponse(
    modelId: string,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
    labels?: Record<string, string>,
    spec?: ModelSpec,
  ): Promise<ChatInferenceResult> {
    const { actualId, config } = this.resolveModelId(modelId);
    this.logger.log(`▶ Google provideLanguageModelChatResponse called — requested: ${modelId} -> executed: ${actualId}, msgs: ${messages.length}`);

    const requestLabels = labels || this.labels;
    if (Object.keys(requestLabels).length > 0) {
      this.logger.log(`  🏷️  Labels: ${JSON.stringify(requestLabels)}`);
    }
    const charCount = { system: 0, user_text: 0, assistant_text: 0, image: 0, tool_use: 0, tool_result: 0 };
    let inputTokens = 0,
      outputTokens = 0,
      cacheRead = 0,
      cacheCreate = 0;

    try {
      const { mappedContents, systemInstruction } = this.extractMessages(messages, charCount, modelId, actualId);

      const generationConfig: any = { ...config };

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
          parameters: this.sanitizeSchemaForVertex(t.inputSchema || { type: "object", properties: {} }),
        }));
        generationConfig.tools = [{ functionDeclarations: declarations }];
      }

      if (Object.keys(requestLabels).length > 0) {
        generationConfig.labels = requestLabels;
      }

      const client = await this.getClient();
      const stream = await withRetry<AsyncIterable<any>>(
        () =>
          client.models.generateContentStream({
            model: actualId,
            contents: mappedContents,
            config: generationConfig,
          }),
        {
          token: token,
        },
      );

      const processor = new StreamPartProcessor(this, modelId, actualId, progress, charCount, this.logger);
      const bufferedCalls: Array<{ callId: string; callName: string; args: any; signature?: string }> = [];

      for await (const chunk of stream) {
        if (token.isCancellationRequested) {
          break;
        }

        const rawParts: any[] | undefined = chunk.candidates?.[0]?.content?.parts;
        const inlineSignatureByName = new Map<string, string>();

        if (rawParts) {
          this.logRawParts(rawParts);
          processor.processRawParts(rawParts, inlineSignatureByName);
        }

        const functionCalls = chunk.functionCalls;
        if (functionCalls && functionCalls.length > 0) {
          for (const fc of functionCalls) {
            const callName = fc.name || "unknown";
            const callId = `${callName}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
            const signature = inlineSignatureByName.get(callName) ?? processor.pendingThoughtSignature;
            this.logger.log(`  🔧 FunctionCall buffered: name=${callName} callId=${callId} inlineSig=${inlineSignatureByName.has(callName)} pendingSig=${!!processor.pendingThoughtSignature}`);
            bufferedCalls.push({ callId, callName, args: fc.args ?? {}, signature });
          }
          processor.pendingThoughtSignature = undefined;
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
        this.logger.log(`  🔧 Emitting ${bufferedCalls.length} buffered function call(s)`);
        for (const { callId, callName, args, signature } of bufferedCalls) {
          if (signature) {
            this.thoughtSignatureCache.set(callId, signature);
            this.logger.log(`    💾 Cached thought signature for callId=${callId} (${signature.length} chars)`);
          } else {
            this.logger.log(`    ⚠️  No thought signature for callId=${callId}`);
          }
          progress.report(new vscode.LanguageModelToolCallPart(callId, callName, args));
        }
      }

      // Cache the text signature against the clean answer text so it can be re-attached in history.
      if (processor.latestTextSignature && processor.accumulatedAnswerText.length > 0) {
        const textKey = processor.accumulatedAnswerText.substring(0, 120);
        this.textSignatureCache.set(textKey, processor.latestTextSignature);
        this.logger.log(`    📝 Cached text thought signature for answer turn (${processor.latestTextSignature.length} chars)`);
      }

      this.logger.log(`  ✅ Stream finished successfully`);

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
      this.logger.log(`  ❌ Google provideLanguageModelChatResponse error: ${e}`);
      checkAuthError(e);
      throw e;
    }
  }
}

/**
 * Stateful helper class responsible for parsing raw candidate parts from the Google/Vertex AI stream.
 * It is specifically designed to isolate legacy and inline cryptographic `thoughtSignature` parameters,
 * while automatically detecting and stripping multi-chunk leaked reasoning blocks in high-thinking models.
 */
class StreamPartProcessor {
  public pendingThoughtSignature: string | undefined;
  public latestTextSignature: string | undefined;
  public accumulatedAnswerText = "";
  public inLeakedReasoning = false;

  constructor(
    private readonly provider: VertexGoogleProvider,
    private readonly modelId: string,
    private readonly actualId: string,
    private readonly progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    private readonly charCount: any,
    private readonly logger: Logger,
  ) {}

  /**
   * Processes all raw candidate parts in a single stream chunk.
   * Extracts thought signatures and handles skipping/reporting of text chunks.
   *
   * @param rawParts The raw part objects array returned by the API.
   * @param inlineSignatureByName A map to associate inline signatures with tool call names.
   */
  public processRawParts(rawParts: any[], inlineSignatureByName: Map<string, string>): void {
    for (const part of rawParts) {
      this.extractSignatures(part, inlineSignatureByName);
      this.processTextPart(part);
    }
  }

  /**
   * Identifies and stores any legacy (preceding thought part) or inline thought signatures
   * present on the given part so they can be cached and re-injected in later history turns.
   *
   * @param part The raw part object being inspected.
   * @param inlineSignatureByName A map to associate inline signatures with tool call names.
   */
  private extractSignatures(part: any, inlineSignatureByName: Map<string, string>): void {
    // Legacy: separate thought part with signature (Gemini 2.x thinking)
    if (part.thought === true && part.thoughtSignature) {
      this.pendingThoughtSignature = part.thoughtSignature;
      this.latestTextSignature = part.thoughtSignature;
      this.logger.log(`    ✍️  Captured preceding thought signature (${part.thoughtSignature.length} chars)`);
    }
    // Gemini 3: signature embedded directly on the functionCall part
    if (part.functionCall?.name && part.thoughtSignature) {
      inlineSignatureByName.set(part.functionCall.name, part.thoughtSignature);
      this.logger.log(`    ✍️  Captured inline thought signature for ${part.functionCall.name} (${part.thoughtSignature.length} chars)`);
    }
    // Capture optional signature on final text parts (non-functionCall turns)
    if (part.text !== undefined && part.thoughtSignature && !part.thought) {
      this.latestTextSignature = part.thoughtSignature;
    }
  }

  /**
   * Inspects and handles text parts. Safely filters out explicit thoughts and leaked
   * reasoning/thinking blocks while reporting clean answer text to VS Code.
   *
   * @param part The raw part containing a text property.
   */
  private processTextPart(part: any): void {
    if (part.text === undefined) {
      return;
    }

    if (part.thought) {
      this.logger.log(`    🧠 Skipping reasoning text part (${part.text.length} chars)`);
      return;
    }

    // Skip streamed leaked reasoning chunks if we are already in skipping state
    if (this.inLeakedReasoning) {
      this.handleStreamingLeakedReasoning(part.text);
      return;
    }

    // Detect if this part is the start of a leaked reasoning block
    if (part.thoughtSignature && this.provider.isLeakedReasoningHeader(part.text, this.modelId, this.actualId)) {
      this.logger.log(`    🧠 Detected leaked reasoning block starting for ${this.modelId}`);
      this.handleLeakedReasoningStart(part.text);
      return;
    }

    // Normal text part: report it
    this.emitText(part.text);
  }

  /**
   * Process a streamed leaked reasoning chunk when already in a skipping state.
   * Keeps skipping text until a newline is found, indicating the end of the metadata block.
   *
   * @param text The current raw text chunk.
   */
  private handleStreamingLeakedReasoning(text: string): void {
    const newlineIdx = text.indexOf("\n");
    if (newlineIdx !== -1) {
      this.inLeakedReasoning = false;
      const realText = text.substring(newlineIdx + 1);
      if (realText.length > 0) {
        this.emitText(realText);
      }
    } else {
      this.logger.log(`    🧠 Skipping streamed leaked reasoning chunk (${text.length} chars)`);
    }
  }

  /**
   * Handles the first chunk of a detected leaked reasoning block.
   * If the block contains a newline, it strips the prefix and emits the remaining text.
   * Otherwise, it transitions the processor into the `inLeakedReasoning` skipping state.
   *
   * @param text The current raw text chunk that started with the leaked signature prefix.
   */
  private handleLeakedReasoningStart(text: string): void {
    const newlineIdx = text.indexOf("\n");
    if (newlineIdx !== -1) {
      const realText = text.substring(newlineIdx + 1);
      if (realText.length > 0) {
        this.emitText(realText);
      }
    } else {
      this.inLeakedReasoning = true;
    }
  }

  /**
   * Reports clean, non-metadata answer text back to the VS Code UI and increments
   * assistant character count tracking metrics.
   *
   * @param text The clean text to emit.
   */
  private emitText(text: string): void {
    this.accumulatedAnswerText += text;
    this.progress.report(new vscode.LanguageModelTextPart(text));
    this.charCount.assistant_text += text.length;
  }
}
