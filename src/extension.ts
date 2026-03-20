import * as vscode from "vscode";
import { VertexAnthropicProvider } from "./VertexAnthropicProvider";

export function activate(context: vscode.ExtensionContext) {
  console.log('Congratulations, your extension "vertex-anthropic" is now active!');

  const config = vscode.workspace.getConfiguration("vertexAnthropic");
  const projectId = config.get<string>("projectId") || "";
  const region = config.get<string>("region") || "us-east5"; // Opus 4.6 requires us-east5, europe-west1, or asia-southeast1

  if (!projectId) {
    vscode.window.showWarningMessage("Vertex Anthropic: Project ID is not configured. Please set vertexAnthropic.projectId in settings.");
  }

  const provider = new VertexAnthropicProvider(projectId, region);

  // Register the chat provider
  const disposable = vscode.lm.registerLanguageModelChatProvider("Google Cloud Vertex AI", provider);

  context.subscriptions.push(disposable);
}
