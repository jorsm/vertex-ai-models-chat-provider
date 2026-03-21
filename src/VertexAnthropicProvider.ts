import { AnthropicVertex } from "@anthropic-ai/vertex-sdk";
import * as vscode from "vscode";
import localCatalog from "./models.json";

// ─── Types ──────────────────────────────────────────────────────────────────

interface ModelSpec {
  id: string;
  displayName: string;
  family: string;
  version: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  capabilities: { imageInput: boolean; toolCalling: boolean };
}

interface ModelCatalog {
  candidateModels: ModelSpec[];
  regionPriority: string[];
}

interface DiscoveryResult {
  region: string;
  availableModels: ModelSpec[];
}

// ─── Output channel for diagnostics ─────────────────────────────────────────

const outputChannel = vscode.window.createOutputChannel("Vertex Anthropic");

function log(msg: string): void {
  const ts = new Date().toISOString();
  outputChannel.appendLine(`[${ts}] ${msg}`);
}

// ─── Provider ───────────────────────────────────────────────────────────────

export class VertexAnthropicProvider implements vscode.LanguageModelChatProvider {
  private client!: AnthropicVertex;
  private projectId: string;
  private region = "global";
  private availableModels: ModelSpec[] = [];
  private discoveryDone = false;


  /** Fires when the available model list changes — VS Code re-queries provideLanguageModelChatInformation. */
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this._onDidChange.event;

  constructor(projectId: string) {
    this.projectId = projectId;
  }

  // ── Model catalog loading ─────────────────────────────────────────────

  /**
   * Load model catalog: try remote URL first (if configured), fall back to bundled JSON.
   * Remote fetch has a 3-second timeout so it never blocks startup significantly.
   */
  private async loadModelCatalog(): Promise<ModelCatalog> {
    const catalogUrl = vscode.workspace.getConfiguration("vertexAnthropic").get<string>("modelCatalogUrl");

    if (catalogUrl) {
      try {
        log(`📡 Fetching remote model catalog: ${catalogUrl}`);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3000);

        const response = await fetch(catalogUrl, { signal: controller.signal });
        clearTimeout(timeout);

        if (response.ok) {
          const remote = (await response.json()) as ModelCatalog;
          if (remote.candidateModels?.length > 0 && remote.regionPriority?.length > 0) {
            log(`✅ Remote catalog loaded — ${remote.candidateModels.length} candidate model(s)`);
            return remote;
          }
          log(`⚠️  Remote catalog has invalid structure, using bundled catalog`);
        } else {
          log(`⚠️  Remote catalog returned ${response.status}, using bundled catalog`);
        }
      } catch (e) {
        log(`⚠️  Remote catalog fetch failed: ${e}, using bundled catalog`);
      }
    }

    log(`📦 Using bundled model catalog — ${localCatalog.candidateModels.length} candidate model(s)`);
    return localCatalog as ModelCatalog;
  }

  // ── Discovery ───────────────────────────────────────────────────────────

  /**
   * Discover working region and available models by pinging candidates.
   *
   * Strategy:
   *   1. Try "global" endpoint first (routes to nearest region automatically).
   *   2. If global fails for *all* candidates, try each regional endpoint in
   *      priority order until at least one model responds.
   *   3. The first region where ≥1 model responds is used for all inference.
   */
  async discoverModelsAndRegion(): Promise<DiscoveryResult> {
    const catalog = await this.loadModelCatalog();
    const candidates = catalog.candidateModels;
    const regions = catalog.regionPriority;

    log(`Starting model discovery for project "${this.projectId}"…`);
    log(`Candidate models: ${candidates.map((m) => m.id).join(", ")}`);
    log(`Region priority: ${regions.join(" → ")}`);

    for (const region of regions) {
      log(`  Probing region "${region}"…`);
      const client = new AnthropicVertex({
        projectId: this.projectId,
        region,
      });

      const available: ModelSpec[] = [];

      for (const model of candidates) {
        const ok = await this.pingModel(client, model.id);
        if (ok) {
          available.push(model);
        }
      }

      if (available.length > 0) {
        log(`✅ Region "${region}" — ${available.length} model(s) available: ${available.map((m) => m.id).join(", ")}`);

        // Commit and notify VS Code
        this.region = region;
        this.client = client;
        this.availableModels = available;
        this.discoveryDone = true;
        this._onDidChange.fire();

        return { region, availableModels: available };
      }

      log(`  ⚠️  No models responded in "${region}", trying next…`);
    }

    // Nothing worked
    log("❌ No models available in any region.");
    this.availableModels = [];
    this.discoveryDone = true;
    this._onDidChange.fire();

    return { region: "none", availableModels: [] };
  }

  /**
   * Send a minimal ping (max_tokens: 1) to see if a model is available.
   */
  private async pingModel(client: AnthropicVertex, modelId: string): Promise<boolean> {
    try {
      await client.messages.create({
        model: modelId,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
      });
      log(`    🏓 ${modelId} → ✅`);
      return true;
    } catch {
      log(`    🏓 ${modelId} → ❌`);
      return false;
    }
  }

  // ── Re-discovery (project changed) ────────────────────────────────────

  /**
   * Update the project ID. Call `discoverModelsAndRegion()` afterwards to
   * re-run discovery with the new project.
   */
  setProjectId(projectId: string): void {
    this.projectId = projectId;
    this.discoveryDone = false;

  }

  // ── Chat provider interface ───────────────────────────────────────────

  provideLanguageModelChatInformation(_options: vscode.PrepareLanguageModelChatModelOptions, _token: vscode.CancellationToken): vscode.ProviderResult<vscode.LanguageModelChatInformation[]> {
    if (!this.discoveryDone || this.availableModels.length === 0) {
      return [];
    }

    return this.availableModels.map((m) => ({
      id: m.id,
      name: `Vertex ${m.displayName}`,
      family: m.family,
      version: m.version,
      maxInputTokens: m.maxInputTokens,
      maxOutputTokens: m.maxOutputTokens,
      capabilities: {
        imageInput: m.capabilities.imageInput,
        toolCalling: m.capabilities.toolCalling,
      },
    }));
  }

  // ── Token counting (heuristic: ~4 chars per token) ─────────────────────

  async provideTokenCount(_model: vscode.LanguageModelChatInformation, text: string | vscode.LanguageModelChatRequestMessage, _token: vscode.CancellationToken): Promise<number> {
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
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const modelId = model.version;
    log(`▶ provideLanguageModelChatResponse called — model: ${modelId}, region: ${this.region}, messages: ${messages.length}`);

    try {
      // Extract system prompt from System-role messages
      const systemParts: string[] = [];
      const mappedMessages: any[] = [];

      for (const msg of messages) {
        const roleNum = msg.role;
        log(`  Message role=${roleNum}, parts=${msg.content.length}`);

        // System messages → Anthropic "system" parameter
        if (roleNum !== vscode.LanguageModelChatMessageRole.User && roleNum !== vscode.LanguageModelChatMessageRole.Assistant) {
          for (const part of msg.content) {
            if (part instanceof vscode.LanguageModelTextPart && part.value.length > 0) {
              systemParts.push(part.value);
            }
          }
          continue;
        }

        const role = roleNum === vscode.LanguageModelChatMessageRole.User ? "user" : "assistant";
        const contentParts: any[] = [];

        for (const part of msg.content) {
          if (part instanceof vscode.LanguageModelTextPart) {
            if (part.value.length > 0) {
              contentParts.push({ type: "text", text: part.value });
            }
          } else if (part instanceof vscode.LanguageModelToolResultPart) {
            let toolResultStr = "";
            if (Array.isArray(part.content)) {
              toolResultStr = part.content
                .map((c) => {
                  if (c instanceof vscode.LanguageModelTextPart) {
                    return c.value;
                  }
                  return JSON.stringify(c);
                })
                .join("\n");
            }
            contentParts.push({
              type: "tool_result",
              tool_use_id: part.callId,
              content: toolResultStr || " ",
            });
          } else if (part instanceof vscode.LanguageModelToolCallPart) {
            contentParts.push({
              type: "tool_use",
              id: part.callId,
              name: part.name,
              input: part.input,
            });
          }
        }

        if (contentParts.length === 0) {
          contentParts.push({ type: "text", text: " " });
        }
        mappedMessages.push({ role, content: contentParts });
      }

      // Ensure the first message is from the user (Anthropic requirement)
      if (mappedMessages.length === 0 || mappedMessages[0].role !== "user") {
        log(`  ⚠️  No user messages — inserting placeholder`);
        mappedMessages.unshift({ role: "user", content: [{ type: "text", text: " " }] });
      }

      const tools: any[] | undefined = options.tools?.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema ?? { type: "object", properties: {} },
      }));

      const spec = this.availableModels.find((m) => m.id === modelId);
      const maxTokens = spec?.maxOutputTokens ?? 4096;

      const systemPrompt = systemParts.length > 0 ? systemParts.join("\n\n") : undefined;

      log(`  Sending: model=${modelId}, max_tokens=${maxTokens}, msgs=${mappedMessages.length}, system=${systemPrompt ? systemPrompt.length + " chars" : "none"}, tools=${tools?.length ?? 0}`);

      const stream = await this.client.messages.create({
        model: modelId,
        messages: mappedMessages,
        max_tokens: maxTokens,
        stream: true,
        ...(systemPrompt ? { system: systemPrompt } : {}),
        ...(tools?.length ? { tools } : {}),
      });

      log(`  Stream created successfully`);

      let activeToolCallId = "";
      let activeToolName = "";
      let activeToolJson = "";
      let chunkCount = 0;

      for await (const chunk of stream) {
        chunkCount++;
        if (chunkCount <= 5) {
          log(`  Chunk #${chunkCount}: type=${chunk.type}`);
        }

        if (token.isCancellationRequested) {
          log(`  Cancelled after ${chunkCount} chunks`);
          break;
        }

        if (chunk.type === "message_start") {
          const usage = (chunk as any).message?.usage;
          if (usage) {
            log(`  📊 Input tokens: ${usage.input_tokens ?? "?"}, cache_read: ${usage.cache_read_input_tokens ?? 0}, cache_create: ${usage.cache_creation_input_tokens ?? 0}`);
          }
        } else if (chunk.type === "message_delta") {
          const usage = (chunk as any).usage;
          if (usage) {
            log(`  📊 Output tokens: ${usage.output_tokens ?? "?"}`);
          }
        } else if (chunk.type === "content_block_delta" && chunk.delta.type === "text_delta") {
          progress.report(new vscode.LanguageModelTextPart(chunk.delta.text));
        } else if (chunk.type === "content_block_start" && chunk.content_block.type === "tool_use") {
          activeToolCallId = chunk.content_block.id;
          activeToolName = chunk.content_block.name;
          activeToolJson = "";
        } else if (chunk.type === "content_block_delta" && chunk.delta.type === "input_json_delta") {
          activeToolJson += chunk.delta.partial_json;
        } else if (chunk.type === "content_block_stop" && activeToolCallId) {
          let parsedInput = {};
          try {
            parsedInput = JSON.parse(activeToolJson);
          } catch {
            // Ignore JSON parse errors
          }

          progress.report(new vscode.LanguageModelToolCallPart(activeToolCallId, activeToolName, parsedInput));
          activeToolCallId = "";
          activeToolName = "";
          activeToolJson = "";
        }
      }
      log(`  ✅ Stream finished — ${chunkCount} chunks total`);
    } catch (e) {
      log(`  ❌ provideLanguageModelChatResponse error: ${e}`);
      throw e;
    }
  }
}
