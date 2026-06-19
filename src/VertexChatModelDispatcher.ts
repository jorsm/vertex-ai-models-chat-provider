import * as childProcess from "child_process";
import * as util from "util";
import * as vscode from "vscode";
import { AuthManager } from "./AuthManager";
import { ModelCatalogResolver } from "./ModelCatalogResolver";
import { VertexAnthropicProvider } from "./providers/VertexAnthropicProvider";
import { VertexGoogleProvider } from "./providers/VertexGoogleProvider";
import { VertexMaaSProvider } from "./providers/VertexMaaSProvider";
import { VertexModelProvider } from "./providers/VertexModelProvider";
import { UsageTrackerService } from "./UsageTrackerService";
import { Logger } from "./utils/Logger";
import { estimateTokens } from "./utils/tokens";

const execAsync = util.promisify(childProcess.exec);

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

// ─── Dispatcher ─────────────────────────────────────────────────────────────

export class VertexChatModelDispatcher implements vscode.LanguageModelChatProvider {
  private projectId: string;
  private region = "global";
  private availableModels: ModelSpec[] = [];
  private readonly activeProviders: Map<string, VertexModelProvider> = new Map();
  private discoveryDone = false;
  private readonly usageTracker: UsageTrackerService;
  private readonly authManager: AuthManager;
  private readonly catalogResolver: ModelCatalogResolver;
  private _discoveryPromise: Promise<DiscoveryResult> | null = null;
  private _labelsPromise: Promise<void> | null = null;
  private cachedUserEmail: string | undefined;
  private readonly logger = new Logger("VertexChatModelDispatcher");

  /** Fires when the available model list changes — VS Code re-queries provideLanguageModelChatInformation. */
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this._onDidChange.event;

  constructor(projectId: string, usageTracker: UsageTrackerService, authManager: AuthManager, catalogResolver: ModelCatalogResolver) {
    this.projectId = projectId;
    this.usageTracker = usageTracker;
    this.authManager = authManager;
    this.catalogResolver = catalogResolver;
    this.registerProviders();
    this._labelsPromise = this.updateLabels();

    // Re-resolve identity and update labels when authentication changes
    this.authManager.onAuthUpdated(() => {
      this.updateLabels().catch((err) => this.logger.log(`⚠️ Failed to update labels on auth change: ${err}`));
    });
  }

  private registerProviders() {
    // Currently hardcoded, could be dynamic in the future
    const anthropicProvider = new VertexAnthropicProvider();
    this.logger.log(`Registered plugin for vendor: ${anthropicProvider.vendor}`);
    this.activeProviders.set(anthropicProvider.vendor, anthropicProvider);

    const googleProvider = new VertexGoogleProvider();
    this.logger.log(`Registered plugin for vendor: ${googleProvider.vendor}`);
    this.activeProviders.set(googleProvider.vendor, googleProvider);

    const maasProvider = new VertexMaaSProvider();
    maasProvider.setCatalogResolver(this.catalogResolver);
    this.logger.log(`Registered plugin for vendor: ${maasProvider.vendor}`);
    this.activeProviders.set(maasProvider.vendor, maasProvider);
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
      this.cachedUserEmail = await this.authManager.getIdentity();
    }

    // Still push the user label to providers as a baseline
    const labels: Record<string, string> = {};
    if (this.cachedUserEmail) {
      labels["vscode-vertex-ai-user"] = this.sanitizeLabelValue(this.cachedUserEmail);
    }

    this.logger.log(`Updating base labels for providers: ${JSON.stringify(labels)}`);
    for (const provider of this.activeProviders.values()) {
      provider.setLabels(labels);
    }
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
    const catalog = this.catalogResolver.getEffectiveCatalog();
    const candidates = catalog.candidateModels;
    const regions = catalog.regionPriority;

    const authOptions = await this.authManager.getResolvedAuthOptions();
    /*
     * Resolve project ID: Strictly use the workspace setting.
     *
     * DESIGN CHOICE: We do NOT fall back to the project ID found in service account credentials.
     * The setting 'vertexAiChat.projectId' is the absolute source of truth for billing.
     * If the credentials provided (Service Account or ADC) do not match or have access
     * to this specific project, the extension is designed to fail loudly.
     */
    const effectiveProjectId = this.projectId;

    if (!effectiveProjectId) {
      this.logger.log("❌ No Project ID configured in settings (vertexAiChat.projectId). Discovery aborted.");
      vscode.window.showErrorMessage("Vertex AI: Please configure a GCP Project ID in your settings to use this extension.");
      this.availableModels = [];
      this.discoveryDone = true;
      this._onDidChange.fire();
      return { region: "none", availableModels: [] };
    }

    /*
     * Validation: If using a Service Account, warn if its home project doesn't match our setting.
     *
     * NOTE: This is a warning, not an error, because cross-project IAM is a valid GCP pattern
     * (e.g., a Service Account created in Project A having 'Vertex AI User' role in Project B).
     */
    if (authOptions?.projectId && authOptions.projectId !== effectiveProjectId) {
      const msg = `Configuration Note: Settings specify project '${effectiveProjectId}', but Service Account belongs to '${authOptions.projectId}'. Proceeding assuming cross-project IAM permissions.`;
      this.logger.log(`⚠️ ${msg}`);
      vscode.window.showWarningMessage(`Vertex AI: ${msg}`);
      // We do NOT return or abort here, allowing the provider.pingModel to perform the actual access check.
    }

    this.logger.log(`Starting model discovery for project "${effectiveProjectId}"…`);

    for (const region of regions) {
      this.logger.log(`  Probing region "${region}"…`);
      const available: ModelSpec[] = [];

      for (const model of candidates) {
        const provider = this.activeProviders.get(model.vendor);
        if (!provider) {
          this.logger.log(`  ⚠️  No provider registered for vendor "${model.vendor}", skipping ${model.id}`);
          continue;
        }

        provider.initialize(effectiveProjectId, region, authOptions);
        try {
          const ok = await provider.pingModel(model.version);
          if (ok) {
            available.push(model);
          }
        } catch (e: any) {
          // If we hit an authentication error, we should stop trying other regions
          // and bubble the error up to the UI.
          if (e.name === "VertexAuthenticationError") {
            this.logger.log(`❌ Authentication error during discovery: ${e.message}`);
            throw e;
          }
          this.logger.log(`  ⚠️ Ping failed for ${model.id} in ${region}: ${e.message || e}`);
        }
      }

      if (available.length > 0) {
        this.logger.log(`✅ Region "${region}" — ${available.length} model(s) available: ${available.map((m) => m.id).join(", ")}`);

        this.region = region;
        this.availableModels = available;
        this.discoveryDone = true;
        this._onDidChange.fire();

        return { region, availableModels: available };
      }

      this.logger.log(`  ⚠️  No models responded in "${region}", trying next…`);
    }

    this.logger.log("❌ No models available in any region.");
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
    this.logger.log("🚫 Available models cleared due to error.");
  }

  // ── Chat provider interface ───────────────────────────────────────────

  provideLanguageModelChatInformation(_options: vscode.PrepareLanguageModelChatModelOptions, _token: vscode.CancellationToken): vscode.ProviderResult<vscode.LanguageModelChatInformation[]> {
    return this.mapModels();
  }

  private mapModels(): vscode.LanguageModelChatInformation[] {
    const models = this.availableModels.length > 0 ? this.availableModels : this.catalogResolver.getEffectiveCatalog().candidateModels;

    // Check if we are running in VS Code 1.120 or higher
    const versionParts = vscode.version.split(".");
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

    return estimateTokens(text);
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
      this.logger.log(`  ⏳ Waiting for model discovery to complete before inference...`);
      await this._discoveryPromise;
    }
    if (this._labelsPromise) {
      await this._labelsPromise;
    }

    const modelId = model.id;
    const spec = (this.availableModels.length > 0 ? this.availableModels : this.catalogResolver.getEffectiveCatalog().candidateModels).find((m) => m.id === modelId);

    this.logger.log(`▶ provideLanguageModelChatResponse called — model: ${modelId}, region: ${this.region}, vendor: ${spec?.vendor}, messages: ${messages.length}`);

    if (!spec) {
      this.logger.log(`  ❌ Model ID ${modelId} not found in available models catalog`);
      throw new Error(`Model not available: ${modelId}`);
    }

    const provider = this.activeProviders.get(spec.vendor);
    if (!provider) {
      this.logger.log(`  ❌ No plugin provider found for vendor ${spec.vendor}`);
      throw new Error(`Integration for vendor ${spec.vendor} is not registered.`);
    }

    // Resolve labels for this specific request (resource-aware)
    const activeEditor = vscode.window.activeTextEditor;
    const config = vscode.workspace.getConfiguration("vertexAiChat", activeEditor?.document.uri);
    const requestLabels: Record<string, string> = {};

    if (config.get<boolean>("enableUserLabel")) {
      // 0. Check for a custom user label value in settings
      let userValue = config.get<string>("userLabelValue");

      if (!userValue) {
        // 1. Fallback to cached identity
        userValue = this.cachedUserEmail;
      }

      if (userValue) {
        requestLabels["vscode-vertex-ai-user"] = this.sanitizeLabelValue(userValue);
      }
    }

    if (config.get<boolean>("enableProjectLabel")) {
      // 0. Check for a custom project label value in settings (Workspace/Folder level only)
      const inspection = config.inspect<string>("projectLabelValue");
      let projectName = inspection?.workspaceValue || inspection?.workspaceFolderValue;

      if (!projectName) {
        // 1. Try to use the workspace name (e.g. from .code-workspace file)
        projectName = vscode.workspace.name;

        if (!projectName) {
          // 2. Fallback to the active editor's workspace folder
          if (activeEditor) {
            projectName = vscode.workspace.getWorkspaceFolder(activeEditor.document.uri)?.name;
          }
        }

        if (!projectName) {
          // 3. Final fallback to the first workspace folder
          projectName = vscode.workspace.workspaceFolders?.[0]?.name;
        }
      }

      if (projectName) {
        requestLabels["vscode-vertex-ai-project"] = this.sanitizeLabelValue(projectName);
      }
    }

    try {
      const result = await provider.provideLanguageModelChatResponse(modelId, messages, options, progress, token, requestLabels);
      this.logger.log(`  ✅ Successfully completed request via plugin ${provider.vendor}`);

      if (result.usage.input > 0 || result.usage.output > 0) {
        this.usageTracker
          .recordUsage(model.id, {
            input: result.usage.input,
            output: result.usage.output,
            cache_read: result.usage.cache_read,
            cache_create: result.usage.cache_create,
            characters: result.charCount,
          })
          .catch((err) => this.logger.log(`  ⚠️ Failed to record usage: ${err}`));
      }
    } catch (e) {
      this.logger.log(`  ❌ provideLanguageModelChatResponse error: ${e}`);
      throw e;
    }
  }
}
