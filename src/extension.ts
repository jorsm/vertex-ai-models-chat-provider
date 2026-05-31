import * as vscode from "vscode";
import { AuthManager } from "./AuthManager";
import { generateCommitMessage } from "./CommitMessage";
import { CostStatusBar } from "./CostStatusBar";
import { DashboardWebview } from "./DashboardWebview";
import { UsageTrackerService } from "./UsageTrackerService";
import { VertexChatModelDispatcher } from "./VertexChatModelDispatcher";
import { Logger } from "./utils/Logger";
import { VertexAuthenticationError } from "./utils/retry";

export async function activate(context: vscode.ExtensionContext) {
  // Initialize the logger
  Logger.initialize();

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

  const usageTracker = new UsageTrackerService(context);
  const costStatusBar = new CostStatusBar(usageTracker, authManager);
  context.subscriptions.push(costStatusBar);

  const provider = new VertexChatModelDispatcher(projectId, usageTracker, authManager);

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
  context.subscriptions.push(vscode.commands.registerCommand("vertexAiChat.setServiceAccountKey", () => authManager.setServiceAccountKey().then(() => runDiscovery(provider, authManager))));
  context.subscriptions.push(vscode.commands.registerCommand("vertexAiChat.setServiceAccountPath", () => authManager.setServiceAccountPath().then(() => runDiscovery(provider, authManager))));
  context.subscriptions.push(vscode.commands.registerCommand("vertexAiChat.selectAuthMethod", () => authManager.selectAuthMethod().then(() => runDiscovery(provider, authManager))));
  context.subscriptions.push(vscode.commands.registerCommand("vertexAiChat.clearAuthMethod", () => authManager.clearAuthMethod().then(() => runDiscovery(provider, authManager))));

  context.subscriptions.push(
    vscode.commands.registerCommand("vertexAiChat.dumpTools", () => {
      const outputChannel = vscode.window.createOutputChannel("Vertex AI Models Chat Provider: Tools Dump");
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

  // If projectId is present, run discovery in the background on activation
  runDiscovery(provider, authManager);

  // Re-run discovery when projectId setting changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (e.affectsConfiguration("vertexAiChat.projectId")) {
        const newConfig = vscode.workspace.getConfiguration("vertexAiChat");
        const newProjectId = newConfig.get<string>("projectId") || "";
        if (newProjectId) {
          vscode.window.showInformationMessage(`Vertex AI Models Chat Provider: Project changed to "${newProjectId}". Re-discovering models…`);
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
      vscode.window.showInformationMessage(`Vertex AI Models Chat Provider: ${result.availableModels.length} model(s) available via ${result.region}: ${names}`);
    } else {
      // No models found: warn user to check their project configuration
      vscode.window.showWarningMessage("Vertex AI Models Chat Provider: No models available. Check your Vertex AI Model Garden setup.");
    }
  } catch (e: any) {
    // Clear any stale model list to prevent "silent fallbacks" in the chat UI
    provider.clearModels();

    if (e instanceof VertexAuthenticationError) {
      // Specialized handling for expired/invalid Google Cloud credentials
      const loginAction = "Login with gcloud";
      const selection = await vscode.window.showErrorMessage(e.message, loginAction);

      if (selection === loginAction) {
        // Automation: open a terminal and run the auth command if the user clicks the button
        const terminal = vscode.window.createTerminal({
          name: "Vertex AI: Authentication",
          iconPath: new vscode.ThemeIcon("key"),
        });

        // Use the shell integration API to watch the terminal output in real-time.
        // As soon as gcloud prints "Credentials saved to file", we trigger a refresh
        // so the user doesn't have to wait for the command to finish or manually click anything.
        const disposable = vscode.window.onDidStartTerminalShellExecution(async (event) => {
          if (event.terminal === terminal) {
            for await (const data of event.execution.read()) {
              if (data.includes("Credentials saved to file")) {
                vscode.window.showInformationMessage("Vertex AI: Authentication successful! Refreshing models…");
                runDiscovery(provider, authManager);
                disposable.dispose(); // Cleanup the listener
                break;
              }
            }
          }
        });

        terminal.show();
        // Use the configured project ID to avoid unnecessary API prompts on the default project,
        // and --quiet to exit cleanly after credentials are saved.
        const projectId = vscode.workspace.getConfiguration("vertexAiChat").get<string>("projectId") || "";
        const command = projectId ? `gcloud auth application-default login --project ${projectId} --quiet` : "gcloud auth application-default login --quiet";
        terminal.sendText(command);
      }
    } else {
      // Generic fallback for other discovery failures (e.g., networking, project ID errors)
      vscode.window.showErrorMessage(`Vertex AI Models Chat Provider: Discovery failed — ${e}`);
    }
  }
}
