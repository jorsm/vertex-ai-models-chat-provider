import * as vscode from "vscode";
import * as child_process from "child_process";
import * as util from "util";
import localCatalog from "./models.json";
import { VertexAnthropicProvider } from "./providers/VertexAnthropicProvider";
import { VertexGoogleProvider } from "./providers/VertexGoogleProvider";
import { VertexModelProvider } from "./providers/VertexModelProvider";
import { UsageTrackerService } from "./UsageTrackerService";

const execAsync = util.promisify(child_process.exec);

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
  pricing: {
    input: number;
    output: number;
    cache_read?: number;
    cache_create?: number;
  };
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

const outputChannel = vscode.window.createOutputChannel("Vertex AI Models: Dispatcher");

function log(msg: string): void {
  const ts = new Date().toISOString();
  outputChannel.appendLine(`[${ts}] ${msg}`);
}

// ─── Dispatcher ─────────────────────────────────────────────────────────────

export class VertexChatModelDispatcher implements vscode.LanguageModelChatProvider {
  private projectId: string;
  private region = "global";
  private availableModels: ModelSpec[] = [];
  private readonly activeProviders: Map<string, VertexModelProvider> = new Map();
  private discoveryDone = false;
  private readonly usageTracker: UsageTrackerService;
  private _discoveryPromise: Promise<DiscoveryResult> | null = null;
  private _labelsPromise: Promise<void> | null = null;
  private cachedUserEmail: string | undefined;

  /** Fires when the available model list changes — VS Code re-queries provideLanguageModelChatInformation. */
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this._onDidChange.event;

  constructor(projectId: string, usageTracker: UsageTrackerService) {
    this.projectId = projectId;
    this.usageTracker = usageTracker;
    this.registerProviders();
    this._labelsPromise = this.updateLabels();
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

  public updateLabels(): Promise<void> {
    this._labelsPromise = this._updateLabelsImpl();
    return this._labelsPromise;
  }

  private async _updateLabelsImpl(): Promise<void> {
    const config = vscode.workspace.getConfiguration("vertexAiChat");
    const enableUser = config.get<boolean>("enableUserLabel");

    this.cachedUserEmail = undefined;
    if (enableUser) {
      this.cachedUserEmail = await this.getUserEmail();
    }

    // Still push the user label to providers as a baseline
    const labels: Record<string, string> = {};
    if (this.cachedUserEmail) {
      labels["vscode-vertex-ai-user"] = this.sanitizeLabelValue(this.cachedUserEmail);
    }

    log(`Updating base labels for providers: ${JSON.stringify(labels)}`);
    for (const provider of this.activeProviders.values()) {
      provider.setLabels(labels);
    }
  }

  private async getUserEmail(): Promise<string | undefined> {
    try {
      const { stdout } = await execAsync("gcloud config get-value account");
      const email = stdout.trim();
      if (email && email !== "(unset)") {
        return email;
      }
    } catch (e) {
      log(`  ⚠️  Failed to get gcloud account email: ${e}`);
    }
    return undefined;
  }

  private sanitizeLabelValue(value: string): string {
    // GCP labels: lowercase letters, numbers, hyphens, underscores. Max 63 chars.
    // Must start with a lowercase letter or international character (we stick to a-z).
    let sanitized = value.toLowerCase().replace(/[^a-z0-9_-]/g, "_");
    // Ensure it starts with a letter (if it doesn't, prepend 'v_')
    if (sanitized.length > 0 && !/^[a-z]/.test(sanitized)) {
      sanitized = "v_" + sanitized;
    }
    return sanitized.substring(0, 63);
  }

  getAnthropicProvider(): VertexAnthropicProvider {
    return this.activeProviders.get("anthropic") as VertexAnthropicProvider;
  }

  getGoogleProvider(): VertexGoogleProvider {
    return this.activeProviders.get("google") as VertexGoogleProvider;
  }

  // ── Discovery ───────────────────────────────────────────────────────────

  discoverModelsAndRegion(): Promise<DiscoveryResult> {
    if (!this._discoveryPromise) {
      this._discoveryPromise = this._discoverModelsAndRegionImpl().finally(() => {
        this._discoveryPromise = null;
      });
    }
    return this._discoveryPromise;
  }

  private async _discoverModelsAndRegionImpl(): Promise<DiscoveryResult> {
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

  /**
   * Clears all available models and notifies VS Code of the change.
   * Useful when authentication fails to prevent stale models from being used.
   */
  public clearModels(): void {
    this.availableModels = [];
    this.discoveryDone = false;
    this._onDidChange.fire();
    log("🚫 Available models cleared due to error.");
  }

  // ── Chat provider interface ───────────────────────────────────────────

  provideLanguageModelChatInformation(_options: vscode.PrepareLanguageModelChatModelOptions, _token: vscode.CancellationToken): vscode.ProviderResult<vscode.LanguageModelChatInformation[]> {
    return this.mapModels();
  }

  private mapModels(): vscode.LanguageModelChatInformation[] {
    const models = this.availableModels.length > 0 ? this.availableModels : (localCatalog as ModelCatalog).candidateModels;
    
    // Check if we are running in VS Code 1.120 or higher
    const versionParts = vscode.version.split('.');
    const isV120OrHigher = Number.parseInt(versionParts[0]) > 1 || (Number.parseInt(versionParts[0]) === 1 && Number.parseInt(versionParts[1]) >= 120);

    return models.map((m) => {
      const pricingInfo = `$${m.pricing.input}/1M in, $${m.pricing.output}/1M out`;
      const info: any = {
        id: m.id,
        name: m.displayName,
        detail: `Vertex AI (${this.region}) • ${pricingInfo}`,
        tooltip: `${m.displayName} via Google Cloud Vertex AI (${this.region})\n${pricingInfo}`,
        family: m.family,
        version: m.version,
        maxInputTokens: m.maxInputTokens,
        maxOutputTokens: m.maxOutputTokens,
        capabilities: {
          imageInput: m.capabilities.imageInput,
          toolCalling: m.capabilities.toolCalling,
        },
      };

      if (isV120OrHigher) {
        // Internal/Proposed properties to ensure visibility in Copilot Chat picker (VS Code 1.120+)
        info.vendor = "google-vertex";
        info.isUserSelectable = true;
      }

      return info as vscode.LanguageModelChatInformation;
    });
  }

  async provideTokenCount(modelChatInfo: vscode.LanguageModelChatInformation, text: string | vscode.LanguageModelChatRequestMessage, token: vscode.CancellationToken): Promise<number> {
    const spec = this.availableModels.find((m) => m.id === modelChatInfo.id);
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
    if (this._discoveryPromise) {
      log(`  ⏳ Waiting for model discovery to complete before inference...`);
      await this._discoveryPromise;
    }
    if (this._labelsPromise) {
      await this._labelsPromise;
    }

    const modelId = model.id;
    const spec = (this.availableModels.length > 0 ? this.availableModels : (localCatalog as ModelCatalog).candidateModels).find((m) => m.id === modelId);

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

    // Resolve labels for this specific request
    const config = vscode.workspace.getConfiguration("vertexAiChat");
    const requestLabels: Record<string, string> = {};
    
    if (config.get<boolean>("enableUserLabel") && this.cachedUserEmail) {
      requestLabels["vscode-vertex-ai-user"] = this.sanitizeLabelValue(this.cachedUserEmail);
    }

    if (config.get<boolean>("enableProjectLabel")) {
      let projectName: string | undefined;
      const activeEditor = vscode.window.activeTextEditor;
      if (activeEditor) {
        projectName = vscode.workspace.getWorkspaceFolder(activeEditor.document.uri)?.name;
      }
      if (!projectName) {
        projectName = vscode.workspace.workspaceFolders?.[0]?.name || vscode.workspace.name;
      }
      if (projectName) {
        requestLabels["vscode-vertex-ai-project"] = this.sanitizeLabelValue(projectName);
      }
    }

    try {
      const result = await provider.provideLanguageModelChatResponse(modelId, messages, options, progress, token, requestLabels);
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
