import * as vscode from "vscode";
import { generateCommitMessage } from "./CommitMessage";
import { CostStatusBar } from "./CostStatusBar";
import { DashboardWebview } from "./DashboardWebview";
import { UsageTrackerService } from "./UsageTrackerService";
import { VertexChatModelDispatcher } from "./VertexChatModelDispatcher";

export async function activate(context: vscode.ExtensionContext) {
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

  if (!projectId) {
    vscode.window.showWarningMessage("Vertex AI Models Chat Provider: Project ID is not configured. Please set vertexAiChat.projectId in settings.");
    return;
  }

  const usageTracker = new UsageTrackerService(context);
  const costStatusBar = new CostStatusBar(usageTracker);
  context.subscriptions.push(costStatusBar);

  const provider = new VertexChatModelDispatcher(projectId, usageTracker);

  // Register dashboard command
  context.subscriptions.push(
    vscode.commands.registerCommand("claudeBilling.showDashboard", () => {
      DashboardWebview.createOrShow(context.extensionUri, usageTracker);
    }),
  );

  // Register the chat provider
  const disposable = vscode.lm.registerLanguageModelChatProvider("Google Cloud Vertex AI", provider);
  context.subscriptions.push(disposable);

  // Run discovery in the background on activation
  runDiscovery(provider);

  // Register the "Refresh Models" command (Ctrl+Shift+P → Vertex AI Models Chat Provider: Refresh Models)
  context.subscriptions.push(vscode.commands.registerCommand("vertexAiChat.refreshModels", () => runDiscovery(provider)));

  // Register command for SCM "Generate Commit Message" button in the CHANGES toolbar
  context.subscriptions.push(vscode.commands.registerCommand("vertexAiChat.generateCommitMessage", (resourceUri?: vscode.Uri) => generateCommitMessage(provider.getGoogleProvider(), usageTracker, resourceUri)));

  // Re-run discovery when projectId setting changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (e.affectsConfiguration("vertexAiChat.projectId")) {
        const newConfig = vscode.workspace.getConfiguration("vertexAiChat");
        const newProjectId = newConfig.get<string>("projectId") || "";
        if (newProjectId) {
          vscode.window.showInformationMessage(`Vertex AI Models Chat Provider: Project changed to "${newProjectId}". Re-discovering models…`);
          provider.setProjectId(newProjectId);
          await runDiscovery(provider);
        }
      }
    }),
  );
}

async function runDiscovery(provider: VertexChatModelDispatcher): Promise<void> {
  try {
    const result = await provider.discoverModelsAndRegion();
    if (result.availableModels.length > 0) {
      const names = result.availableModels.map((m) => m.displayName).join(", ");
      vscode.window.showInformationMessage(`Vertex AI Models Chat Provider: ${result.availableModels.length} model(s) available via ${result.region}: ${names}`);
    } else {
      vscode.window.showWarningMessage("Vertex AI Models Chat Provider: No models available. Check your Vertex AI Model Garden setup.");
    }
  } catch (e) {
    vscode.window.showErrorMessage(`Vertex AI Models Chat Provider: Discovery failed — ${e}`);
  }
}
