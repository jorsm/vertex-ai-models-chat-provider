import * as vscode from "vscode";
import localCatalog from "./models.json";
import { VertexAnthropicProvider } from "./providers/VertexAnthropicProvider";
import { VertexGoogleProvider } from "./providers/VertexGoogleProvider";
import { VertexModelProvider } from "./providers/VertexModelProvider";
import { UsageTrackerService } from "./UsageTrackerService";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ModelSpec {
  id: string;
  vendor: string;
  displayName: string;
  family: string;
  version: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  capabilities: { imageInput: boolean; toolCalling: boolean };
}

export interface ModelCatalog {
  candidateModels: ModelSpec[];
  regionPriority: string[];
}

export interface DiscoveryResult {
  region: string;
  availableModels: ModelSpec[];
}

// ─── Output channel for diagnostics ─────────────────────────────────────────

const outputChannel = vscode.window.createOutputChannel("Vertex AI Models Chat Provider");

function log(msg: string): void {
  const ts = new Date().toISOString();
  outputChannel.appendLine(`[${ts}] ${msg}`);
}

// ─── Dispatcher ─────────────────────────────────────────────────────────────

export class VertexChatModelDispatcher implements vscode.LanguageModelChatProvider {
  private projectId: string;
  private region = "global";
  private availableModels: ModelSpec[] = [];
  private activeProviders: Map<string, VertexModelProvider> = new Map();
  private discoveryDone = false;
  private readonly usageTracker: UsageTrackerService;

  /** Fires when the available model list changes — VS Code re-queries provideLanguageModelChatInformation. */
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this._onDidChange.event;

  constructor(projectId: string, usageTracker: UsageTrackerService) {
    this.projectId = projectId;
    this.usageTracker = usageTracker;
    this.registerProviders();
  }

  private registerProviders() {
    // Currently hardcoded, could be dynamic in the future
    const anthropicProvider = new VertexAnthropicProvider();
    log(`Registered plugin for vendor: ${anthropicProvider.vendor}`);
    this.activeProviders.set(anthropicProvider.vendor, anthropicProvider);

    const googleProvider = new VertexGoogleProvider();
    log(`Registered plugin for vendor: ${googleProvider.vendor}`);
    this.activeProviders.set(googleProvider.vendor, googleProvider);
  }

  getAnthropicProvider(): VertexAnthropicProvider {
    return this.activeProviders.get("anthropic") as VertexAnthropicProvider;
  }

  getGoogleProvider(): VertexGoogleProvider {
    return this.activeProviders.get("google") as VertexGoogleProvider;
  }

  // ── Discovery ───────────────────────────────────────────────────────────

  async discoverModelsAndRegion(): Promise<DiscoveryResult> {
    const catalog = localCatalog as ModelCatalog;
    const candidates = catalog.candidateModels;
    const regions = catalog.regionPriority;

    log(`Starting model discovery for project "${this.projectId}"…`);

    for (const region of regions) {
      log(`  Probing region "${region}"…`);
      const available: ModelSpec[] = [];

      for (const model of candidates) {
        const provider = this.activeProviders.get(model.vendor);
        if (!provider) {
          log(`  ⚠️  No provider registered for vendor "${model.vendor}", skipping ${model.id}`);
          continue;
        }

        provider.initialize(this.projectId, region);
        const ok = await provider.pingModel(model.version);
        if (ok) {
          available.push(model);
        }
      }

      if (available.length > 0) {
        log(`✅ Region "${region}" — ${available.length} model(s) available: ${available.map((m) => m.id).join(", ")}`);

        this.region = region;
        this.availableModels = available;
        this.discoveryDone = true;
        this._onDidChange.fire();

        return { region, availableModels: available };
      }

      log(`  ⚠️  No models responded in "${region}", trying next…`);
    }

    log("❌ No models available in any region.");
    this.availableModels = [];
    this.discoveryDone = true;
    this._onDidChange.fire();

    return { region: "none", availableModels: [] };
  }

  // ── Re-discovery (project changed) ────────────────────────────────────

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

  async provideTokenCount(modelChatInfo: vscode.LanguageModelChatInformation, text: string | vscode.LanguageModelChatRequestMessage, token: vscode.CancellationToken): Promise<number> {
    const spec = this.availableModels.find((m) => m.id === modelChatInfo.version);
    const provider = this.activeProviders.get(spec?.vendor || "");

    if (provider?.provideTokenCount) {
      return provider.provideTokenCount(text, token);
    }

    // Fallback heuristic: ~4 chars per token, used to check if the request is too long to send to the model
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
    const spec = this.availableModels.find((m) => m.id === modelId);

    log(`▶ provideLanguageModelChatResponse called — model: ${modelId}, region: ${this.region}, vendor: ${spec?.vendor}, messages: ${messages.length}`);

    if (!spec) {
      log(`  ❌ Model ID ${modelId} not found in available models catalog`);
      throw new Error(`Model not available: ${modelId}`);
    }

    const provider = this.activeProviders.get(spec.vendor);
    if (!provider) {
      log(`  ❌ No plugin provider found for vendor ${spec.vendor}`);
      throw new Error(`Integration for vendor ${spec.vendor} is not registered.`);
    }

    try {
      const result = await provider.provideLanguageModelChatResponse(modelId, messages, options, progress, token);
      log(`  ✅ Successfully completed request via plugin ${provider.vendor}`);

      if (result.usage.input > 0 || result.usage.output > 0) {
        this.usageTracker
          .recordUsage(model.id, {
            input: result.usage.input,
            output: result.usage.output,
            cache_read: result.usage.cache_read,
            cache_create: result.usage.cache_create,
            characters: result.charCount,
          })
          .catch((err) => log(`  ⚠️ Failed to record usage: ${err}`));
      }
    } catch (e) {
      log(`  ❌ provideLanguageModelChatResponse error: ${e}`);
      throw e;
    }
  }
}
