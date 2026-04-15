import { AnthropicVertex } from "@anthropic-ai/vertex-sdk";
import * as vscode from "vscode";
import { ChatInferenceResult, VertexModelProvider } from "./VertexModelProvider";

// ─── Output channel for diagnostics ─────────────────────────────────────────

const outputChannel = vscode.window.createOutputChannel("Vertex AI Models: Anthropic Provider");

function log(msg: string): void {
  const ts = new Date().toISOString();
  outputChannel.appendLine(`[${ts}] ${msg}`);
}

// ─── Provider Plugin ───────────────────────────────────────────────────────

export class VertexAnthropicProvider implements VertexModelProvider {
  vendor = "anthropic";
  private client!: AnthropicVertex;
  private projectId!: string;
  private region!: string;

  initialize(projectId: string, region: string): void {
    this.projectId = projectId;
    this.region = region;
    this.client = new AnthropicVertex({
      projectId: this.projectId,
      region: this.region,
    });
  }

  async pingModel(modelId: string): Promise<boolean> {
    try {
      await this.client.messages.create({
        model: modelId,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
      });
      log(`    🏓 Anthropic ${modelId} → ✅`);
      return true;
    } catch {
      log(`    🏓 Anthropic ${modelId} → ❌`);
      return false;
    }
  }

  // ── Token counting (heuristic: ~4 chars per token) ─────────────────────

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

  // ── Chat response (inference) ─────────────────────────────────────────

  async provideLanguageModelChatResponse(
    modelId: string,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<ChatInferenceResult> {
    log(`▶ Anthropic Plugin provideLanguageModelChatResponse called — model: ${modelId}, region: ${this.region}, messages: ${messages.length}`);

    try {
      const charCount = { system: 0, user_text: 0, assistant_text: 0, image: 0, tool_use: 0, tool_result: 0 };

      const { systemBlocks, mappedMessages } = this.mapMessages(messages, charCount);

      const tools = this.mapTools(options, charCount);

      this.applyCacheControl(tools, systemBlocks, mappedMessages);

      this.logMappedMessages(modelId, mappedMessages, systemBlocks, tools);

      const stream = await this.client.messages.create({
        model: modelId,
        messages: mappedMessages,
        max_tokens: 4096,
        stream: true,
        ...(systemBlocks ? { system: systemBlocks } : {}),
        ...(tools?.length ? { tools } : {}),
      });

      log(`  Stream created successfully`);

      const usage = await this.processStream(stream, charCount, progress, token);

      return { usage, charCount };
    } catch (e) {
      log(`  ❌ Anthropic provideLanguageModelChatResponse error: ${e}`);
      throw e;
    }
  }

  // ── Message mapping ───────────────────────────────────────────────────

  private mapMessages(messages: readonly vscode.LanguageModelChatRequestMessage[], charCount: { system: number; user_text: number; assistant_text: number; image: number; tool_use: number; tool_result: number }): { systemBlocks: any[] | undefined; mappedMessages: any[] } {
    const systemParts: string[] = [];
    const mappedMessages: any[] = [];

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const roleNum = msg.role;
      const roleName = this.roleName(roleNum);
      log(`  ── Message [${i}] role=${roleName} (${roleNum}), ${msg.content.length} part(s)`);

      this.logMessageParts(msg.content);

      if (roleNum !== vscode.LanguageModelChatMessageRole.User && roleNum !== vscode.LanguageModelChatMessageRole.Assistant) {
        this.extractSystemParts(msg.content, systemParts, charCount);
        continue;
      }

      const role = roleNum === vscode.LanguageModelChatMessageRole.User ? "user" : "assistant";
      const contentParts = this.mapContentParts(msg.content, role, charCount);
      mappedMessages.push({ role, content: contentParts });
    }

    if (mappedMessages.length === 0 || mappedMessages[0].role !== "user") {
      log(`  ⚠️  No user messages — inserting placeholder`);
      mappedMessages.unshift({ role: "user", content: [{ type: "text", text: " " }] });
    }

    const systemBlocks = systemParts.length > 0 ? systemParts.map((text) => ({ type: "text", text })) : undefined;
    return { systemBlocks, mappedMessages };
  }

  private roleName(roleNum: vscode.LanguageModelChatMessageRole): string {
    if (roleNum === vscode.LanguageModelChatMessageRole.User) {
      return "User";
    }
    if (roleNum === vscode.LanguageModelChatMessageRole.Assistant) {
      return "Assistant";
    }
    return "System";
  }

  private extractSystemParts(content: readonly vscode.LanguageModelChatRequestMessage["content"][number][], systemParts: string[], charCount: { system: number }): void {
    for (const part of content) {
      if (part instanceof vscode.LanguageModelTextPart && part.value.length > 0) {
        systemParts.push(part.value);
        charCount.system += part.value.length;
      }
    }
    log(`     → Extracted as system prompt (${systemParts.length} part(s) so far, ${systemParts.reduce((a, s) => a + s.length, 0)} chars total)`);
  }

  private logMessageParts(content: readonly vscode.LanguageModelChatRequestMessage["content"][number][]): void {
    content.forEach((part, p) => {
      if (part instanceof vscode.LanguageModelTextPart) {
        const preview = part.value.length > 300 ? "…" + part.value.slice(-300) : part.value;
        log(`     Part [${p}] TextPart (${part.value.length} chars): ${preview}`);
      } else if (part instanceof vscode.LanguageModelToolResultPart) {
        log(`     Part [${p}] ToolResultPart callId=${part.callId}, content: ${this.previewToolResult(part)}`);
      } else if (part instanceof vscode.LanguageModelToolCallPart) {
        const inputStr = JSON.stringify(part.input);
        const inputPreview = inputStr.length > 200 ? "…" + inputStr.slice(-200) : inputStr;
        log(`     Part [${p}] ToolCallPart callId=${part.callId}, name=${part.name}, input=${inputPreview}`);
      } else if (part instanceof vscode.LanguageModelDataPart) {
        log(`     Part [${p}] DataPart mime=${part.mimeType}, size=${part.data?.byteLength ?? 0} bytes`);
      } else {
        const keys = Object.keys(part as object);
        const snapshot = keys
          .slice(0, 5)
          .map((k) => `${k}=${String((part as Record<string, unknown>)[k]).slice(0, 50)}`)
          .join(", ");
        log(`     Part [${p}] Unknown part type: ${Object.getPrototypeOf(part)?.constructor?.name ?? typeof part} — keys: [${keys.join(", ")}] ${snapshot}`);
      }
    });
  }

  private previewToolResult(part: vscode.LanguageModelToolResultPart): string {
    if (!Array.isArray(part.content)) {
      const s = String(part.content);
      return s.length > 100 ? "…" + s.slice(-100) : s;
    }
    return part.content
      .map((c) => {
        if (c instanceof vscode.LanguageModelTextPart) {
          return c.value.length > 100 ? "…" + c.value.slice(-100) : c.value;
        }
        return JSON.stringify(c).slice(-100);
      })
      .join(", ");
  }

  private mapContentParts(content: readonly vscode.LanguageModelChatRequestMessage["content"][number][], role: string, charCount: { user_text: number; assistant_text: number; image: number; tool_use: number; tool_result: number }): any[] {
    const contentParts: any[] = [];

    for (const part of content) {
      if (part instanceof vscode.LanguageModelTextPart) {
        this.mapTextPart(part, role, contentParts, charCount);
      } else if (part instanceof vscode.LanguageModelToolResultPart) {
        this.mapToolResultPart(part, contentParts, charCount);
      } else if (part instanceof vscode.LanguageModelToolCallPart) {
        contentParts.push({ type: "tool_use", id: part.callId, name: part.name, input: part.input });
        charCount.tool_use += JSON.stringify(part.input).length + part.name.length;
      } else if (part instanceof vscode.LanguageModelDataPart) {
        this.mapDataPart(part, role, contentParts, charCount);
      }
    }

    if (contentParts.length === 0) {
      contentParts.push({ type: "text", text: " " });
    }
    return contentParts;
  }

  private mapTextPart(part: vscode.LanguageModelTextPart, role: string, contentParts: any[], charCount: { user_text: number; assistant_text: number }): void {
    if (part.value.length === 0) {
      return;
    }
    contentParts.push({ type: "text", text: part.value });
    if (role === "user") {
      charCount.user_text += part.value.length;
    } else {
      charCount.assistant_text += part.value.length;
    }
  }

  private mapToolResultPart(part: vscode.LanguageModelToolResultPart, contentParts: any[], charCount: { tool_result: number }): void {
    let toolResultStr = "";
    if (Array.isArray(part.content)) {
      toolResultStr = part.content.map((c) => (c instanceof vscode.LanguageModelTextPart ? c.value : JSON.stringify(c))).join("\n");
    }
    contentParts.push({ type: "tool_result", tool_use_id: part.callId, content: toolResultStr || " " });
    charCount.tool_result += toolResultStr.length;
  }

  private mapDataPart(part: vscode.LanguageModelDataPart, role: string, contentParts: any[], charCount: { user_text: number; assistant_text: number; image: number }): void {
    if (part.mimeType?.startsWith("image/")) {
      const base64 = Buffer.from(part.data).toString("base64");
      contentParts.push({ type: "image", source: { type: "base64", media_type: part.mimeType, data: base64 } });
      charCount.image += base64.length;
      log(`     🖼️  Mapped image: ${part.mimeType}, ${part.data.byteLength} bytes → base64 (${base64.length} chars)`);
    } else {
      this.mapNonImageDataPart(part, role, contentParts, charCount);
    }
  }

  private mapNonImageDataPart(part: vscode.LanguageModelDataPart, role: string, contentParts: any[], charCount: { user_text: number; assistant_text: number }): void {
    try {
      const text = new TextDecoder().decode(part.data);
      if (text.length > 0) {
        contentParts.push({ type: "text", text });
        if (role === "user") {
          charCount.user_text += text.length;
        } else {
          charCount.assistant_text += text.length;
        }
        log(`     📎 Mapped non-image DataPart (${part.mimeType}) as text (${text.length} chars)`);
      }
    } catch {
      log(`     ⚠️  Skipped non-image DataPart (${part.mimeType}, ${part.data.byteLength} bytes) — could not decode`);
    }
  }

  // ── Tool schema mapping ───────────────────────────────────────────────

  private mapTools(options: vscode.ProvideLanguageModelChatResponseOptions, charCount: { system: number }): any[] | undefined {
    if (!options.tools?.length) {
      return undefined;
    }

    const tools = options.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema ?? { type: "object", properties: {} },
    }));

    log(`  🔧 Tools provided: ${tools.map((t) => t.name).join(", ")}`);
    charCount.system += JSON.stringify(tools).length;
    return tools;
  }

  // ── Cache control ─────────────────────────────────────────────────────

  private applyCacheControl(tools: any[] | undefined, systemBlocks: any[] | undefined, mappedMessages: any[]): void {
    // 1. Static Prefix Caching (System / Tools)
    const prefixCached = this.applyPrefixCache(tools, systemBlocks);

    // 2. Chat History Caching (Messages)
    const { historyCached, historyTokens } = this.applyHistoryCache(mappedMessages);

    log(`  Caching Strategy Applied: Prefix=${prefixCached}, History=${historyCached} (Estimated ${historyTokens} tokens)`);
  }

  private applyPrefixCache(tools: any[] | undefined, systemBlocks: any[] | undefined): boolean {
    if (tools && tools.length > 0) {
      tools.at(-1).cache_control = { type: "ephemeral" };
      return true;
    }
    if (systemBlocks && systemBlocks.length > 0) {
      systemBlocks.at(-1).cache_control = { type: "ephemeral" };
      return true;
    }
    return false;
  }

  private applyHistoryCache(mappedMessages: any[]): { historyCached: boolean; historyTokens: number } {
    let historyTokens = 0;
    for (let i = 0; i < mappedMessages.length - 1; i++) {
      historyTokens += Math.ceil(JSON.stringify(mappedMessages[i]).length / 4);
    }

    if (historyTokens > 1024 && mappedMessages.length > 1) {
      const secondToLast = mappedMessages.at(-2);
      if (secondToLast?.content?.length > 0) {
        secondToLast.content.at(-1).cache_control = { type: "ephemeral" };
        return { historyCached: true, historyTokens };
      }
    }
    return { historyCached: false, historyTokens };
  }

  // ── Logging helpers ───────────────────────────────────────────────────

  private logMappedMessages(modelId: string, mappedMessages: any[], systemBlocks: any[] | undefined, tools: any[] | undefined): void {
    log(`  ── Mapped messages summary ──`);
    for (let i = 0; i < mappedMessages.length; i++) {
      const mm = mappedMessages[i];
      const partsDesc = mm.content.map((p: any) => p.type + (p.cache_control ? " [CACHED]" : "")).join(", ");
      log(`     [${i}] ${mm.role}: ${partsDesc}`);
    }

    const sysCharCount = systemBlocks ? systemBlocks.reduce((a: number, b: any) => a + b.text.length, 0) : 0;
    const sysLog = systemBlocks ? sysCharCount + " chars" : "none";
    log(`  Sending: model=${modelId}, max_tokens=4096, msgs=${mappedMessages.length}, system=${sysLog}, tools=${tools?.length ?? 0}`);
  }

  // ── Stream processing ─────────────────────────────────────────────────

  private async processStream(stream: AsyncIterable<any>, charCount: { assistant_text: number; tool_use: number }, progress: vscode.Progress<vscode.LanguageModelResponsePart>, token: vscode.CancellationToken): Promise<{ input: number; output: number; cache_read: number; cache_create: number }> {
    const toolState = { callId: "", name: "", json: "" };
    const tokenUsage = { input: 0, output: 0, cache_read: 0, cache_create: 0 };
    let chunkCount = 0;

    for await (const chunk of stream) {
      chunkCount++;
      if (token.isCancellationRequested) {
        log(`  Cancelled after ${chunkCount} chunks`);
        break;
      }
      this.handleStreamChunk(chunk, charCount, progress, toolState, tokenUsage);
    }

    log(`  ✅ Stream finished — ${chunkCount} chunks total`);
    return tokenUsage;
  }

  private handleStreamChunk(
    chunk: any,
    charCount: { assistant_text: number; tool_use: number },
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    toolState: { callId: string; name: string; json: string },
    tokenUsage: { input: number; output: number; cache_read: number; cache_create: number },
  ): void {
    if (chunk.type === "message_start") {
      const usage = chunk.message?.usage;
      if (usage) {
        tokenUsage.input = usage.input_tokens ?? 0;
        tokenUsage.cache_read = usage.cache_read_input_tokens ?? 0;
        tokenUsage.cache_create = usage.cache_creation_input_tokens ?? 0;
        log(`  📊 Input tokens: ${tokenUsage.input}, cache_read: ${tokenUsage.cache_read}, cache_create: ${tokenUsage.cache_create}`);
      }
    } else if (chunk.type === "message_delta") {
      const usage = chunk.usage;
      if (usage) {
        tokenUsage.output = usage.output_tokens ?? 0;
        log(`  📊 Output tokens: ${tokenUsage.output}`);
      }
    } else if (chunk.type === "content_block_delta" && chunk.delta.type === "text_delta") {
      charCount.assistant_text += chunk.delta.text.length;
      progress.report(new vscode.LanguageModelTextPart(chunk.delta.text));
    } else {
      this.handleToolStreamChunk(chunk, charCount, progress, toolState);
    }
  }

  private handleToolStreamChunk(chunk: any, charCount: { tool_use: number }, progress: vscode.Progress<vscode.LanguageModelResponsePart>, toolState: { callId: string; name: string; json: string }): void {
    if (chunk.type === "content_block_start" && chunk.content_block.type === "tool_use") {
      toolState.callId = chunk.content_block.id;
      toolState.name = chunk.content_block.name;
      toolState.json = "";
    } else if (chunk.type === "content_block_delta" && chunk.delta.type === "input_json_delta") {
      charCount.tool_use += chunk.delta.partial_json.length;
      toolState.json += chunk.delta.partial_json;
    } else if (chunk.type === "content_block_stop" && toolState.callId) {
      let parsedInput = {};
      try {
        parsedInput = JSON.parse(toolState.json);
      } catch {
        // Ignore JSON parse errors
      }
      progress.report(new vscode.LanguageModelToolCallPart(toolState.callId, toolState.name, parsedInput));
      toolState.callId = "";
      toolState.name = "";
      toolState.json = "";
    }
  }
}
