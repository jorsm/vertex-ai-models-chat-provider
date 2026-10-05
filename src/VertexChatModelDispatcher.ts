import * as childProcess from "child_process";
import * as util from "util";
import { setMaxListeners } from "events";
import * as vscode from "vscode";
import { AuthManager } from "./AuthManager";
import { ProxyGateway, GatewayError } from "./ProxyGateway";
import { ModelCatalogResolver } from "./ModelCatalogResolver";
import { VertexAnthropicProvider } from "./providers/VertexAnthropicProvider";
import { VertexGoogleProvider } from "./providers/VertexGoogleProvider";
import { VertexGrokProvider } from "./providers/VertexGrokProvider";
import { ModelSpec, VertexModelProvider } from "./providers/VertexModelProvider";
import { UsageTrackerService } from "./UsageTrackerService";
import { Logger } from "./utils/Logger";
import { DISCOVERY_PROBE_TIMEOUT_MS, getDiscoveryStartDelayMs, probeWithRetries, resolveDiscoveryTimeoutMs, runDiscoveryQueue } from "./utils/discovery";
import { estimateTokens } from "./utils/tokens";

const execAsync = util.promisify(childProcess.exec);

// ─── Types ──────────────────────────────────────────────────────────────────

export interface DiscoveryResult {
  region: string;
  availableModels: ModelSpec[];
}

// ─── Dispatcher ─────────────────────────────────────────────────────────────

export class VertexChatModelDispatcher implements vscode.LanguageModelChatProvider {
  private projectId: string;
  private gateway?: ProxyGateway;
  private directDiscoveryController?: AbortController;
  private authSubscription?: vscode.Disposable;
  private connectionRevision = 0;
  public getConnectionRevision(): number { return this.connectionRevision; }
  public dispose(): void { this.resetConnection(); this.authSubscription?.dispose(); this._onDidChange.dispose(); }
  private region = "global";
  private availableModels: ModelSpec[] = [];
  private readonly activeProviders: Map<string, VertexModelProvider> = new Map();
  private discoveryDone = false;
  private readonly usageTracker: UsageTrackerService;
  private readonly authManager: AuthManager;
  private readonly catalogResolver: ModelCatalogResolver;
  private _discoveryPromise: Promise<DiscoveryResult> | null = null;
  private readonly discoveryStartDelayMs = getDiscoveryStartDelayMs;
  private _labelsPromise: Promise<void> | null = null;
  private labelUpdateRevision = 0;
  private cachedUserEmail: string | undefined;
  private readonly missingLabelWarnings = new Set<"user" | "project">();
  private readonly logger = new Logger("VertexChatModelDispatcher");

  /** Fires when the available model list changes — VS Code re-queries provideLanguageModelChatInformation. */
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this._onDidChange.event;

  constructor(projectId: string, usageTracker: UsageTrackerService, authManager: AuthManager, catalogResolver: ModelCatalogResolver) {
    this.projectId = projectId;
    this.usageTracker = usageTracker;
    this.authManager = authManager;
    this.catalogResolver = catalogResolver;
    this.catalogResolver.setProxyCatalog?.(this.getProxyUrl() ? [] : undefined);
    this.registerProviders();
    this._labelsPromise = this.updateLabels();

    // Re-resolve identity and update labels when authentication changes
    this.authSubscription = this.authManager.onAuthUpdated(() => {
      this.resetConnection();
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

    const grokProvider = new VertexGrokProvider();
    grokProvider.setCatalogResolver(this.catalogResolver);
    this.logger.log(`Registered plugin for vendor: ${grokProvider.vendor}`);
    this.activeProviders.set(grokProvider.vendor, grokProvider);
  }

  public updateLabels(): Promise<void> {
    const revision = ++this.labelUpdateRevision;
    this._labelsPromise = this._updateLabelsImpl(revision);
    return this._labelsPromise;
  }

  private async _updateLabelsImpl(labelRevision: number): Promise<void> {
    const connectionRevision = this.connectionRevision;
    const config = vscode.workspace.getConfiguration("vertexAiChat");
    const enableUser = config.get<boolean>("enableUserLabel");

    let resolvedIdentity: string | undefined;
    if (enableUser) {
      try {
        resolvedIdentity = await this.authManager.getIdentity();
      } catch {
        this.logger.log("Identity is not available yet; enabled user labels will be resolved before inference.");
      }
    }
    if (connectionRevision !== this.connectionRevision || labelRevision !== this.labelUpdateRevision) {
      return;
    }
    this.cachedUserEmail = resolvedIdentity;

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

  private getValidLabelValue(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    if (!trimmed) {
      return undefined;
    }

    const sanitized = this.sanitizeLabelValue(trimmed);
    return sanitized || undefined;
  }

  private failMissingLabelValue(label: "user" | "project", lookupFailed = false): never {
    const setting = label === "user" ? "vertexAiChat.userLabelValue" : "vertexAiChat.projectLabelValue";
    const reason = lookupFailed ? "automatic value lookup failed" : "no valid value is available";
    const message = `Local configuration error: 'vscode-vertex-ai-${label}' is enabled but ${reason}. No request was sent. Set '${setting}' or fix the automatic value.`;
    this.logger.log(message);
    if (!this.missingLabelWarnings.has(label)) {
      this.missingLabelWarnings.add(label);
      void vscode.window.showErrorMessage(`Google Agent Platform: ${message}`);
    }
    throw vscode.LanguageModelError.Blocked(message);
  }

  private clearMissingLabelWarning(label: "user" | "project"): void {
    this.missingLabelWarnings.delete(label);
  }

  getAnthropicProvider(): VertexAnthropicProvider {
    return this.activeProviders.get("anthropic") as VertexAnthropicProvider;
  }

  getGoogleProvider(): VertexGoogleProvider {
    return this.activeProviders.get("google") as VertexGoogleProvider;
  }

  // ── Discovery ───────────────────────────────────────────────────────────

  /** Only user/machine configuration may select an authenticated destination. */
  public getProxyUrl(): string {
    const setting = vscode.workspace.getConfiguration("vertexAiChat").inspect<string>("proxyUrl");
    return setting?.globalValue?.trim() || setting?.defaultValue?.trim() || "";
  }

  public resetConnection(): void {
    this.connectionRevision++;
    this.gateway?.dispose();
    this.gateway = undefined;
    this.directDiscoveryController?.abort();
    this.directDiscoveryController = undefined;
    this.authManager.clearProxyToken?.();
    this._discoveryPromise = null;
    this.catalogResolver.setProxyCatalog?.(this.getProxyUrl() ? [] : undefined);
    this.clearModels();
    this.discoveryDone = false;
  }

  discoverModelsAndRegion(): Promise<DiscoveryResult> {
    if (!this._discoveryPromise) {
      const promise = this._discoverModelsAndRegionImpl(this.connectionRevision);
      this._discoveryPromise = promise;
      void promise.finally(() => {
        if (this._discoveryPromise === promise) { this._discoveryPromise = null; }
      }).catch(() => {});
    }
    return this._discoveryPromise;
  }

  private async _discoverModelsAndRegionImpl(revision: number): Promise<DiscoveryResult> {
    const probeTimeoutMs = resolveDiscoveryTimeoutMs(
      vscode.workspace.getConfiguration("vertexAiChat").get<number>("modelDiscoveryTimeoutSeconds", DISCOVERY_PROBE_TIMEOUT_MS / 1000),
    );

    const proxyUrl = this.getProxyUrl();
    if (revision !== this.connectionRevision) { throw new Error("Configuration changed during discovery."); }
    /*
     * The project ID is mandatory in every mode: it is the billing/quota project for
     * direct Vertex calls and is forwarded as-is to the proxy when proxyUrl is set.
     */
    const effectiveProjectId = this.projectId.trim();
    if (!effectiveProjectId) {
      this.logger.log("❌ No Project ID configured in settings (vertexAiChat.projectId). Discovery aborted.");
      vscode.window.showErrorMessage("Vertex AI: Please configure a GCP Project ID in your settings to use this extension.");
      this.clearModels();
      return { region: "none", availableModels: [] };
    }
    if (proxyUrl) {
      this.gateway?.dispose();
      const gateway = new ProxyGateway(proxyUrl, () => this.authManager.getProxyIdToken());
      this.gateway = gateway;
      this.availableModels = [];
      this.discoveryDone = false;
      this._onDidChange.fire();
      try {
        const available = await gateway.discover(probeTimeoutMs, gateway.signal);
        if (revision !== this.connectionRevision || gateway.signal.aborted) {
          throw new GatewayError("Proxy configuration changed. Refresh Models before continuing.");
        }
        for (const vendor of ["google", "anthropic"]) {
          this.activeProviders.get(vendor)?.initialize(effectiveProjectId, "global", undefined, gateway);
        }
        this.region = "proxy";
        this.availableModels = available;
        this.catalogResolver.setProxyCatalog?.(available);
        this.discoveryDone = true;
        this._onDidChange.fire();
        return { region: "proxy", availableModels: available };
      } catch (error) {
        if (revision === this.connectionRevision) { this.clearModels(); }
        throw error;
      }
    }

    const catalog = await this.catalogResolver.getEffectiveCatalog();
    if (revision !== this.connectionRevision) { throw new Error("Configuration changed during discovery."); }
    const candidates = catalog.candidateModels;
    const regions = catalog.regionPriority;
    const authOptions = await this.authManager.getResolvedAuthOptions();
    if (revision !== this.connectionRevision) { throw new Error("Configuration changed during discovery."); }
    /*
     * Resolve project ID: Strictly use the workspace setting.
     *
     * DESIGN CHOICE: We do NOT fall back to the project ID found in service account credentials.
     * The setting 'vertexAiChat.projectId' is the absolute source of truth for billing.
     * If the credentials provided (Service Account or ADC) do not match or have access
     * to this specific project, the extension is designed to fail loudly.
     */

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

    // Providers own alias resolution; group by vendor and backend model, not UI ID.
    const targets = new Map<string, { provider: VertexModelProvider; modelId: string; models: ModelSpec[] }>();
    for (const model of candidates) {
      const provider = this.activeProviders.get(model.vendor);
      if (!provider) {
        this.logger.log(`  ⚠️  No provider registered for vendor "${model.vendor}", skipping ${model.id}`);
        continue;
      }
      const modelId = provider.getDiscoveryModelId(model.version);
      const key = JSON.stringify([model.vendor, modelId]);
      const target = targets.get(key);
      if (target) {
        target.models.push(model);
      } else {
        targets.set(key, { provider, modelId, models: [model] });
      }
    }
    const probeTargets = [...targets.values()];

    for (const region of regions) {
      if (revision !== this.connectionRevision) { throw new Error("Configuration changed during discovery."); }
      this.logger.log(`  Probing region "${region}" (${probeTargets.length} unique model endpoints for ${candidates.length} catalog entries)…`);

      // Initialize each active provider once for this region
      for (const provider of this.activeProviders.values()) {
        provider.initialize(effectiveProjectId, region, authOptions);
      }

      // Probe each endpoint once and share its result with all catalog variants.
      const regionController = new AbortController();
      this.directDiscoveryController = regionController;
      setMaxListeners(probeTargets.length + 1, regionController.signal);
      const probeTarget = async ({ provider, modelId, models }: typeof probeTargets[number]) => {
        try {
          const ok = await probeWithRetries(
            (options) => {
              regionController.signal.throwIfAborted();
              return provider.pingModel(modelId, options);
            },
            regionController.signal,
            (reachable) => this.logger.log(`  ⏱️ Ping timed out for ${modelId} in ${region} after ${probeTimeoutMs}ms; ${reachable ? "keeping" : "skipping"} ${models.length} catalog entries.`),
            probeTimeoutMs,
            (message) => this.logger.log(`  ${modelId} in ${region}: ${message}`),
          );
          if (ok) {
            return models;
          }
        } catch (e: any) {
          // If we hit an authentication error, we should bubble it up immediately
          if (e.name === "VertexAuthenticationError") {
            this.logger.log(`❌ Authentication error during discovery for ${modelId}: ${e.message}`);
            throw e;
          }
          this.logger.log(`  ⚠️ Ping failed for ${modelId} in ${region}: ${e.message || e}`);
        }
        return [];
      };

      let results: ModelSpec[][];
      try {
        results = await runDiscoveryQueue(probeTargets, probeTarget, regionController.signal, this.discoveryStartDelayMs);
      } finally {
        // Also stop sibling probes when an authentication failure aborts discovery.
        regionController.abort();
        if (this.directDiscoveryController === regionController) { this.directDiscoveryController = undefined; }
      }

      if (revision !== this.connectionRevision) { throw new Error("Configuration changed during discovery."); }
      const reachableModels = new Set(results.flat());
      const available = candidates.filter((model) => reachableModels.has(model));

      if (available.length > 0) {
        this.logger.log(`✅ Region "${region}" — ${available.length} model(s) available: ${available.map((m: ModelSpec) => m.id).join(", ")}`);

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
    this.resetConnection();
  }

  /**
   * Clears all available models and notifies VS Code of the change.
   * Useful when authentication fails to prevent stale models from being used.
   */
  public clearModels(): void {
    this.availableModels = [];
    if (this.getProxyUrl()) { this.catalogResolver.setProxyCatalog?.([]); }
    this.discoveryDone = true;
    this._onDidChange.fire();
    this.logger.log("🚫 Available models cleared due to error.");
  }

  // ── Chat provider interface ───────────────────────────────────────────

  async provideLanguageModelChatInformation(_options: vscode.PrepareLanguageModelChatModelOptions, _token: vscode.CancellationToken): Promise<vscode.LanguageModelChatInformation[]> {
    return await this.mapModels();
  }

  private async mapModels(): Promise<vscode.LanguageModelChatInformation[]> {
    const catalog = await this.catalogResolver.getEffectiveCatalog();
    const models = this.getProxyUrl() || this.discoveryDone || this.availableModels.length > 0 ? this.availableModels : catalog.candidateModels;

    // Check if we are running in VS Code 1.120 or higher
    const versionParts = vscode.version.split(".");
    const isV120OrHigher = Number.parseInt(versionParts[0]) > 1 || (Number.parseInt(versionParts[0]) === 1 && Number.parseInt(versionParts[1]) >= 120);

    return models.map((m: ModelSpec) => {
      const pricing = this.formatPricingDisplay(m.pricing);
      const info: any = {
        id: m.id,
        name: m.displayName,
        detail: `Vertex AI (${this.region}) • ${pricing.detail}`,
        tooltip: `Google Cloud Vertex AI · ${this.region}\n\n${pricing.tooltip}`,
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

  private formatPricingDisplay(pricing: ModelSpec["pricing"]): { detail: string; tooltip: string } {
    const basic = `$${pricing.input} in · $${pricing.output} out /1M`;
    if (!pricing.longContext) {
      return {
        detail: basic,
        tooltip: `**Pricing per 1M tokens**\n\n${this.formatRateCard(pricing)}`,
      };
    }

    const threshold = `${pricing.longContext.inputThresholdTokens / 1_000}K`;
    return {
      detail: `≤${threshold}: ${basic}*`,
      tooltip: [
        "**Pricing per 1M tokens**",
        "",
        `**Up to ${threshold} input context**  `,
        this.formatRateCard(pricing),
        "",
        `**Over ${threshold} input context**  `,
        this.formatRateCard(pricing.longContext),
        "",
        `Above ${threshold}, long-context rates apply to every token in the request.`,
      ].join("\n"),
    };
  }

  private formatRateCard(rates: Pick<ModelSpec["pricing"], "input" | "output" | "cache_read" | "cache_create">): string {
    const parts = [`Input: **$${rates.input}**`, `Output: **$${rates.output}**`];
    if (rates.cache_read !== undefined) {
      parts.push(`Cache hit: **$${rates.cache_read}**`);
    }
    if (rates.cache_create !== undefined && rates.cache_create > 0) {
      parts.push(`Cache write: **$${rates.cache_create}**`);
    }
    return parts.join(" · ");
  }

  async provideTokenCount(modelChatInfo: vscode.LanguageModelChatInformation, text: string | vscode.LanguageModelChatRequestMessage, token: vscode.CancellationToken): Promise<number> {
    const spec = this.availableModels.find((m: ModelSpec) => m.id === modelChatInfo.id);
    const provider = this.activeProviders.get(spec?.vendor || "");

    if (provider?.provideTokenCount) {
      return provider.provideTokenCount(text, token);
    }

    return estimateTokens(text);
  }

  // ── Chat response (inference) ─────────────────────────────────────────

  private async waitForDiscovery(token: vscode.CancellationToken): Promise<void> {
    if (token.isCancellationRequested) {
      throw new vscode.CancellationError();
    }
    const discovery = this._discoveryPromise;
    if (!discovery) {
      return;
    }
    this.logger.log(`  ⏳ Waiting for model discovery to complete before inference...`);
    let subscription: vscode.Disposable | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        const cancel = () => reject(new vscode.CancellationError());
        subscription = token.onCancellationRequested(cancel);
        if (token.isCancellationRequested) {
          cancel();
        }
        discovery.then(() => resolve(), reject);
      });
    } finally {
      subscription?.dispose();
    }
  }

  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    try {
      await this.infer(model.id, messages, options, progress, token, vscode.window.activeTextEditor?.document.uri);
    } catch (error) {
      // Generic Error loses the HTTP classification across the VS Code RPC boundary.
      if (error instanceof GatewayError) {
        const message = `HTTP ${error.status ?? "unknown"}: ${error.message}`;
        if (error.status === 401 || error.status === 403) {
          throw vscode.LanguageModelError.NoPermissions(message);
        }
        if (error.status === 404) { throw vscode.LanguageModelError.NotFound(message); }
        if ((error.status && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status))
          || error.policyCode === "UPSTREAM_AUTHENTICATION_FAILED") {
          throw vscode.LanguageModelError.Blocked(message);
        }
      }
      throw error;
    }
  }

  private getCommitMessageModels(): ModelSpec[] {
    return this.availableModels.filter((entry) => {
      if (!this.activeProviders.has(entry.vendor)) {
        return false;
      }
      return !this.getProxyUrl() || ["google", "anthropic"].includes(entry.vendor);
    });
  }

  /** Returns the currently authorized commit models, refreshing an empty catalog once. */
  public async getAvailableCommitMessageModels(): Promise<ModelSpec[]> {
    if (this.availableModels.length === 0) {
      await this.discoverModelsAndRegion();
    } else if (this._discoveryPromise) {
      await this._discoveryPromise;
    }
    return this.getCommitMessageModels();
  }

  public async inferCommit(
    messages: readonly vscode.LanguageModelChatRequestMessage[], options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>, token: vscode.CancellationToken, resource: vscode.Uri,
  ): Promise<void> {
    const requestLabels = await this.resolveRequestLabels(resource, token);
    if (token.isCancellationRequested) { throw new vscode.CancellationError(); }
    // A previous discovery error clears the catalog and marks that attempt as
    // completed. An explicit commit-generation request gets one fresh attempt
    // instead of remaining stuck behind the stale empty state.
    if (!this._discoveryPromise && (!this.discoveryDone || this.availableModels.length === 0)) {
      void this.discoverModelsAndRegion().catch(() => {});
    }
    await this.waitForDiscovery(token);
    const candidates = this.getCommitMessageModels();
    const configuredModelId = vscode.workspace.getConfiguration("vertexAiChat", resource)
      .get<string>("commitMessageModel")?.trim();
    const configuredModel = configuredModelId
      ? candidates.find((entry) => entry.id === configuredModelId)
      : undefined;

    if (configuredModelId && !configuredModel) {
      throw new Error(`Configured commit-message model '${configuredModelId}' is not available or authorized. Select another model or use automatic selection.`);
    }

    const model = configuredModel
      ?? candidates.find((entry) => entry.vendor === "google" && entry.family.toLowerCase() === "gemini"
        && entry.id.toLowerCase().includes("flash") && !/(?:-high|-max)$/.test(entry.id.toLowerCase()))
      ?? candidates.find((entry) => entry.vendor === "google" && entry.family.toLowerCase() === "gemini")
      ?? candidates.find((entry) => entry.vendor === "google")
      ?? candidates.find((entry) => entry.vendor === "anthropic")
      ?? candidates[0];
    if (!model) { throw new Error("No authorized model is available for commit generation. Refresh Models or check the proxy policy."); }
    this.logger.log(`Commit-message model selected: ${model.id}${configuredModel ? " (configured)" : " (automatic)"}`);
    await this.inferWithLabels(model.id, messages, options, progress, token, requestLabels);
  }

  private async resolveRequestLabels(resource: vscode.Uri | undefined, token: vscode.CancellationToken): Promise<Record<string, string>> {
    if (token.isCancellationRequested) { throw new vscode.CancellationError(); }
    const revision = this.connectionRevision;
    // Resolve labels for this specific request (resource-aware)
    const config = vscode.workspace.getConfiguration("vertexAiChat", resource);
    const requestLabels: Record<string, string> = {};

    if (config.get<boolean>("enableUserLabel")) {
      // 0. Check for a custom user label value in settings
      let userLabelValue = this.getValidLabelValue(config.get<string>("userLabelValue"));

      if (!userLabelValue) {
        // Use the request's scoped checkbox, rather than the startup configuration.
        let identity: string | undefined;
        try {
          identity = await this.authManager.getIdentity();
        } catch (error) {
          if (error instanceof vscode.CancellationError || token.isCancellationRequested) { throw new vscode.CancellationError(); }
          this.failMissingLabelValue("user", true);
        }
        if (token.isCancellationRequested) { throw new vscode.CancellationError(); }
        if (revision !== this.connectionRevision) { throw new Error("Configuration changed before inference. Refresh Models."); }
        userLabelValue = this.getValidLabelValue(identity);
      }

      if (userLabelValue) {
        this.clearMissingLabelWarning("user");
        requestLabels["vscode-vertex-ai-user"] = userLabelValue;
      } else {
        this.failMissingLabelValue("user");
      }
    } else {
      this.clearMissingLabelWarning("user");
    }

    if (config.get<boolean>("enableProjectLabel")) {
      // 0. Check for a custom project label value in settings (Workspace/Folder level only)
      const inspection = config.inspect<string>("projectLabelValue");
      let projectLabelValue = this.getValidLabelValue(inspection?.workspaceFolderValue || inspection?.workspaceValue);

      if (!projectLabelValue) {
        // 1. Try to use the workspace name (e.g. from .code-workspace file)
        const folder = resource ? vscode.workspace.getWorkspaceFolder(resource) : undefined;
        projectLabelValue = this.getValidLabelValue(vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 1 ? folder?.name : vscode.workspace.name);

        if (!projectLabelValue) {
          // 2. Fallback to the active editor's workspace folder
          if (resource) {
            projectLabelValue = this.getValidLabelValue(vscode.workspace.getWorkspaceFolder(resource)?.name);
          }
        }

        if (!projectLabelValue) {
          // 3. Final fallback to the first workspace folder
          projectLabelValue = this.getValidLabelValue(vscode.workspace.workspaceFolders?.[0]?.name);
        }
      }

      if (projectLabelValue) {
        this.clearMissingLabelWarning("project");
        requestLabels["vscode-vertex-ai-project"] = projectLabelValue;
      } else {
        this.failMissingLabelValue("project");
      }
    } else {
      this.clearMissingLabelWarning("project");
    }

    return requestLabels;
  }

  public async infer(
    modelId: string, messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>, token: vscode.CancellationToken,
    resource?: vscode.Uri,
  ): Promise<void> {
    const requestLabels = await this.resolveRequestLabels(resource, token);
    return this.inferWithLabels(modelId, messages, options, progress, token, requestLabels);
  }

  private async inferWithLabels(
    modelId: string, messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>, token: vscode.CancellationToken,
    requestLabels: Record<string, string>,
  ): Promise<void> {
    if (token.isCancellationRequested) { throw new vscode.CancellationError(); }
    if (this.getProxyUrl() && !this.discoveryDone && !this._discoveryPromise) {
      void this.discoverModelsAndRegion().catch(() => {});
    }
    await this.waitForDiscovery(token);
    const revision = this.connectionRevision;
    const catalog = await this.catalogResolver.getEffectiveCatalog();
    if (token.isCancellationRequested) { throw new vscode.CancellationError(); }
    if (revision !== this.connectionRevision) { throw new Error("Configuration changed before inference. Refresh Models."); }
    const spec = (this.getProxyUrl() || this.discoveryDone || this.availableModels.length > 0 ? this.availableModels : catalog.candidateModels).find((m: ModelSpec) => m.id === modelId);
    if (!spec) { throw new Error(`Model not available: ${modelId}. Refresh Models or select an allowed model.`); }
    const provider = this.activeProviders.get(spec.vendor);
    if (!provider || (this.getProxyUrl() && !["google", "anthropic"].includes(spec.vendor))) {
      throw new Error(`Integration for vendor ${spec.vendor} is not available in this mode.`);
    }

    try {
      const result = await provider.provideLanguageModelChatResponse(modelId, messages, options, progress, token, requestLabels, spec);
      this.logger.log(`  ✅ Successfully completed request via plugin ${provider.vendor}`);

      if (result.usage.input > 0 || result.usage.output > 0) {
        await this.usageTracker
          .recordUsage(modelId, {
            input: result.usage.input,
            output: result.usage.output,
            cache_read: result.usage.cache_read,
            cache_create: result.usage.cache_create,
            characters: result.charCount,
          }, spec.pricing)
          .catch((err) => this.logger.log(`  ⚠️ Failed to record usage: ${err}`));
      }
    } catch (e) {
      this.logger.error(`  ❌ provideLanguageModelChatResponse error`, e);
      throw e;
    }
  }
}
