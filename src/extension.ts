import * as vscode from "vscode";
import { VertexAnthropicProvider } from "./VertexAnthropicProvider";

export function activate(context: vscode.ExtensionContext) {
  const config = vscode.workspace.getConfiguration("vertexAnthropic");
  const projectId = config.get<string>("projectId") || "";

  if (!projectId) {
    vscode.window.showWarningMessage(
      "Vertex Anthropic: Project ID is not configured. Please set vertexAnthropic.projectId in settings.",
    );
    return;
  }

  const provider = new VertexAnthropicProvider(projectId);

  // Register the chat provider
  const disposable = vscode.lm.registerLanguageModelChatProvider("Google Cloud Vertex AI", provider);
  context.subscriptions.push(disposable);

  // Run discovery in the background on activation
  runDiscovery(provider);

  // Register the "Refresh Models" command (Ctrl+Shift+P → Vertex Anthropic: Refresh Models)
  context.subscriptions.push(
    vscode.commands.registerCommand("vertexAnthropic.refreshModels", () => runDiscovery(provider)),
  );

  // Re-run discovery when projectId or modelCatalogUrl settings change
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (e.affectsConfiguration("vertexAnthropic.projectId")) {
        const newConfig = vscode.workspace.getConfiguration("vertexAnthropic");
        const newProjectId = newConfig.get<string>("projectId") || "";
        if (newProjectId) {
          vscode.window.showInformationMessage(`Vertex Anthropic: Project changed to "${newProjectId}". Re-discovering models…`);
          provider.setProjectId(newProjectId);
          await runDiscovery(provider);
        }
      }
      if (e.affectsConfiguration("vertexAnthropic.modelCatalogUrl")) {
        const newUrl = vscode.workspace.getConfiguration("vertexAnthropic").get<string>("modelCatalogUrl") || "";
        vscode.window.showInformationMessage(
          newUrl
            ? `Vertex Anthropic: Catalog URL changed. Re-discovering models…`
            : `Vertex Anthropic: Catalog URL cleared — using bundled catalog. Re-discovering models…`,
        );
        await runDiscovery(provider);
      }
    }),
  );
}

async function runDiscovery(provider: VertexAnthropicProvider): Promise<void> {
  try {
    const result = await provider.discoverModelsAndRegion();
    if (result.availableModels.length > 0) {
      const names = result.availableModels.map((m) => m.displayName).join(", ");
      vscode.window.showInformationMessage(
        `Vertex Anthropic: ${result.availableModels.length} model(s) available via ${result.region}: ${names}`,
      );
    } else {
      vscode.window.showWarningMessage(
        "Vertex Anthropic: No models available. Check your Vertex AI Model Garden setup.",
      );
    }
  } catch (e) {
    vscode.window.showErrorMessage(`Vertex Anthropic: Discovery failed — ${e}`);
  }
}
