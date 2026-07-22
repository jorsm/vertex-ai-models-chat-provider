import * as vscode from "vscode";
import { AuthConfigurationError, AuthManager } from "./AuthManager";
import { generateCommitMessage } from "./CommitMessage";
import { CostStatusBar } from "./CostStatusBar";
import { DashboardWebview } from "./DashboardWebview";
import { ModelCatalogResolver } from "./ModelCatalogResolver";
import { UsageTrackerService } from "./UsageTrackerService";
import { VertexChatModelDispatcher } from "./VertexChatModelDispatcher";
import { Logger } from "./utils/Logger";
import { VertexAuthenticationError } from "./utils/retry";

export async function activate(context: vscode.ExtensionContext) {
  // Initialize the logger
  Logger.initialize();
  const extensionHostKind = context.extension.extensionKind === vscode.ExtensionKind.UI ? "UI" : "workspace";
  const extensionHostLocation = vscode.env.remoteName ? `remote (${vscode.env.remoteName})` : "local";
  Logger.getLogger("extension").log(`Running in the ${extensionHostLocation} ${extensionHostKind} extension host.`);

  const authManager = new AuthManager(context);
  let config = vscode.workspace.getConfiguration("vertexAiChat");
  let projectId = config.get<string>("projectId") || "";

  // Migrate settings from old vertexAnthropic config if vertexAiChat is empty
  if (!projectId) {
    const oldConfig = vscode.workspace.getConfiguration("vertexAnthropic");
    const oldProjectId = oldConfig.get<string>("projectId");
    if (oldProjectId) {
      await config.update("projectId", oldProjectId, vscode.ConfigurationTarget.Global);
      projectId = oldProjectId;
    }
    const oldHideBillingWarning = oldConfig.get<boolean>("hideBillingWarning");
    if (oldHideBillingWarning !== undefined) {
      await config.update("hideBillingWarning", oldHideBillingWarning, vscode.ConfigurationTarget.Global);
    }
  }

  const catalogResolver = new ModelCatalogResolver(context);
  context.subscriptions.push(catalogResolver);

  const usageTracker = new UsageTrackerService(context, catalogResolver);
  const costStatusBar = new CostStatusBar(usageTracker, authManager, catalogResolver);
  context.subscriptions.push(costStatusBar);

  const provider = new VertexChatModelDispatcher(projectId, usageTracker, authManager, catalogResolver);

  // Register dashboard command
  context.subscriptions.push(
    vscode.commands.registerCommand("claudeBilling.showDashboard", () => {
      DashboardWebview.createOrShow(context.extensionUri, usageTracker);
    }),
  );

  // Register the chat provider
  const disposable = vscode.lm.registerLanguageModelChatProvider("google-vertex", provider);
  context.subscriptions.push(disposable);

  // Register the "Refresh Models" command (Ctrl+Shift+P → Vertex AI Models Chat Provider: Refresh Models)
  context.subscriptions.push(
    vscode.commands.registerCommand("vertexAiChat.refreshModels", async () => {
      const currentProjectId = vscode.workspace.getConfiguration("vertexAiChat").get<string>("projectId");
      provider.setProjectId(currentProjectId || "");
      return runDiscovery(provider, authManager);
    }),
  );

  // Auth management commands
  const refreshAfterAuthChange = async (changeAuth: () => Promise<boolean>) => {
    if (await changeAuth()) {
      await runDiscovery(provider, authManager);
    }
  };
  context.subscriptions.push(vscode.commands.registerCommand("vertexAiChat.setServiceAccountKey", () => refreshAfterAuthChange(() => authManager.setServiceAccountKey())));
  context.subscriptions.push(vscode.commands.registerCommand("vertexAiChat.setServiceAccountPath", () => refreshAfterAuthChange(() => authManager.importServiceAccountFile())));
  context.subscriptions.push(vscode.commands.registerCommand("vertexAiChat.removeServiceAccount", () => refreshAfterAuthChange(() => authManager.removeServiceAccount())));
  context.subscriptions.push(vscode.commands.registerCommand("vertexAiChat.selectAuthMethod", () => refreshAfterAuthChange(() => authManager.selectAuthMethod())));
  context.subscriptions.push(vscode.commands.registerCommand("vertexAiChat.clearAuthMethod", () => authManager.clearAuthMethod().then(() => runDiscovery(provider, authManager))));

  context.subscriptions.push(
    vscode.commands.registerCommand("vertexAiChat.dumpTools", () => {
      const outputChannel = vscode.window.createOutputChannel("Google Agent Platform: Tools Dump");
      outputChannel.show();
      outputChannel.appendLine("=== Installed Language Model Tools ===");

      const tools = vscode.lm.tools;
      if (!tools || tools.length === 0) {
        outputChannel.appendLine("No tools found in vscode.lm.tools.");
        return;
      }

      for (const [index, tool] of tools.entries()) {
        outputChannel.appendLine(`\n[${index}] Tool Name: ${tool.name}`);
        outputChannel.appendLine(`Description: ${tool.description}`);
        outputChannel.appendLine(`Tags: ${tool.tags?.join(", ") ?? "none"}`);
        outputChannel.appendLine("Input Schema:");
        outputChannel.appendLine(JSON.stringify(tool.inputSchema, null, 2));
      }

      outputChannel.appendLine("\n=== End of Dump ===");
    }),
  );

  // Register command for SCM "Generate Commit Message" button in the CHANGES toolbar
  context.subscriptions.push(vscode.commands.registerCommand("vertexAiChat.generateCommitMessage", (resourceUri?: vscode.Uri) => generateCommitMessage(provider.getGoogleProvider(), usageTracker, resourceUri)));

  // ── Custom model catalog commands ────────────────────────────────────
  // Each command seeds the file from the bundled catalog on first run, then opens it
  // in the editor. Both files are covered by contributes.jsonValidation for autocomplete.
  context.subscriptions.push(
    vscode.commands.registerCommand("vertexAiChat.openUserModelsFile", async () => {
      try {
        const uri = await catalogResolver.ensureUserCatalogExists();
        await vscode.window.showTextDocument(uri);
        vscode.window.showInformationMessage("Google Agent Platform: Opened your user-level models.json. Edit and save to update available models.");
      } catch (e: any) {
        vscode.window.showErrorMessage(`Google Agent Platform: Could not open user models.json: ${e.message || e}`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("vertexAiChat.openWorkspaceModelsFile", async () => {
      if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
        vscode.window.showWarningMessage("Google Agent Platform: Open a workspace folder first to create a workspace models.json.");
        return;
      }
      try {
        const uri = await catalogResolver.ensureWorkspaceCatalogExists();
        if (!uri) {
          vscode.window.showWarningMessage("Google Agent Platform: Open a workspace folder first to create a workspace models.json.");
          return;
        }
        await vscode.window.showTextDocument(uri);
        vscode.window.showInformationMessage("Google Agent Platform: Opened .vscode/models.json. Commit it to share models with your team.");
      } catch (e: any) {
        vscode.window.showErrorMessage(`Google Agent Platform: Could not open workspace models.json: ${e.message || e}`);
      }
    }),
  );

  // ── Auto-refresh on custom catalog save ──────────────────────────────
  // Watch both custom files; on any change/create/delete, invalidate the cache and
  // re-run discovery so the Copilot Chat model picker reflects edits. Debounced to
  // avoid double-firing on rapid saves.
  let refreshTimer: NodeJS.Timeout | null = null;
  const triggerCatalogRefresh = () => {
    if (refreshTimer) {
      clearTimeout(refreshTimer);
    }
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      catalogResolver.invalidateCache();
      costStatusBar.updateStatusBar().catch((err) => Logger.getLogger("extension").log(`⚠️ Status bar catalog refresh failed: ${err}`));
      runDiscovery(provider, authManager).catch((err) => Logger.getLogger("extension").log(`⚠️ Catalog refresh discovery failed: ${err}`));
    }, 300);
  };

  // Workspace file watcher (only when a workspace folder is open)
  const wsFolder = vscode.workspace.workspaceFolders?.[0];
  if (wsFolder) {
    const wsPattern = new vscode.RelativePattern(wsFolder, ".vscode/models.json");
    const wsWatcher = vscode.workspace.createFileSystemWatcher(wsPattern);
    wsWatcher.onDidChange(triggerCatalogRefresh);
    wsWatcher.onDidCreate(triggerCatalogRefresh);
    wsWatcher.onDidDelete(triggerCatalogRefresh);
    context.subscriptions.push(wsWatcher);
  }

  // User file watcher (globalStorage path)
  const userPattern = new vscode.RelativePattern(context.globalStorageUri, "models.json");
  const userWatcher = vscode.workspace.createFileSystemWatcher(userPattern);
  userWatcher.onDidChange(triggerCatalogRefresh);
  userWatcher.onDidCreate(triggerCatalogRefresh);
  userWatcher.onDidDelete(triggerCatalogRefresh);
  context.subscriptions.push(userWatcher);

  // If projectId is present, run discovery in the background on activation
  runDiscovery(provider, authManager);

  // Re-run discovery when projectId setting changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (e.affectsConfiguration("vertexAiChat.projectId")) {
        const newConfig = vscode.workspace.getConfiguration("vertexAiChat");
        const newProjectId = newConfig.get<string>("projectId") || "";
        if (newProjectId) {
          vscode.window.showInformationMessage(`Google Agent Platform: Project changed to "${newProjectId}". Re-discovering models…`);
        }
        provider.setProjectId(newProjectId);
        await runDiscovery(provider, authManager);
      }
      if (e.affectsConfiguration("vertexAiChat.enableUserLabel") || e.affectsConfiguration("vertexAiChat.enableProjectLabel")) {
        await provider.updateLabels();
      }
    }),
  );
}

/**
 * Orchestrates the discovery of available Vertex AI models across prioritized regions.
 * Updates the provider's state and notifies the user of the results.
 *
 * @param provider The dispatcher responsible for probing model availability.
 * @param authManager The authentication manager for resolving credentials.
 */
async function runDiscovery(provider: VertexChatModelDispatcher, authManager: AuthManager): Promise<void> {
  try {
    const result = await provider.discoverModelsAndRegion();
    if (result.availableModels.length > 0) {
      // Success: notify user of available models and the selected region
      const names = result.availableModels.map((m) => m.displayName).join(", ");
      vscode.window.showInformationMessage(`Google Agent Platform: ${result.availableModels.length} model(s) available via ${result.region}: ${names}`);
    } else {
      // No models found: warn user to check their project configuration
      vscode.window.showWarningMessage("Google Agent Platform: No models available. Check your Google Cloud Model Garden setup.");
    }
  } catch (e: any) {
    // Clear any stale model list to prevent "silent fallbacks" in the chat UI
    provider.clearModels();

    if (e instanceof AuthConfigurationError) {
      const selectAction = "Select Authentication Method";
      const selection = await vscode.window.showErrorMessage(e.message, selectAction);
      if (selection === selectAction && (await authManager.selectAuthMethod())) {
        await runDiscovery(provider, authManager);
      }
    } else if (e instanceof VertexAuthenticationError) {
      // Specialized handling for expired/invalid Google Cloud credentials
      const loginAction = authManager.getGcloudLoginActionLabel();
      const selection = await vscode.window.showErrorMessage(e.message, loginAction);

      if (selection === loginAction) {
        const projectId = vscode.workspace.getConfiguration("vertexAiChat").get<string>("projectId") || "";
        await authManager.reauthenticate(projectId, () => runDiscovery(provider, authManager));
      }
    } else {
      // Generic fallback for other discovery failures (e.g., networking, project ID errors)
      vscode.window.showErrorMessage(`Vertex AI Models Chat Provider: Discovery failed — ${e}`);
    }
  }
}
