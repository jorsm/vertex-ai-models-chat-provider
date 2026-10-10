import * as vscode from "vscode";
import { resolveCommitMessageResourceUri } from "./CommitMessage";
import type { CommitMessageCommandContext } from "./CommitMessage";
import type { VertexChatModelDispatcher } from "../VertexChatModelDispatcher";
import { EffortCatalog } from "../effort/EffortCatalog";

/** Selects an available model and persists the choice in the commit-message setting. */
export async function selectCommitMessageModel(
  provider: Pick<VertexChatModelDispatcher, "discoverModelsAndRegion">,
  context?: CommitMessageCommandContext,
): Promise<void> {
  const resource = resolveCommitMessageResourceUri(context)
    ?? vscode.window.activeTextEditor?.document.uri
    ?? vscode.workspace.workspaceFolders?.[0]?.uri;

  try {
    const discovered = await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: "Loading commit message models",
    }, () => provider.discoverModelsAndRegion());
    const availableModels = [...new EffortCatalog(discovered.availableModels).models];
    if (availableModels.length === 0) {
      vscode.window.showWarningMessage("Google Agent Platform: No model is available for commit-message generation.");
      return;
    }

    const config = vscode.workspace.getConfiguration("vertexAiChat", resource);
    const current = config.get<string>("commitMessageModel")?.trim();
    const items = availableModels.map((model) => ({
      label: model.displayName,
      description: model.id === current ? `${model.id} · Current` : model.id,
      detail: `${model.vendor} · ${model.family}`,
      modelId: model.id,
    }));
    // showQuickPick cannot preselect a single item; put the configured model first.
    items.sort((a, b) => Number(b.modelId === current) - Number(a.modelId === current));
    const selection = await vscode.window.showQuickPick(items, {
      title: "Select Commit Message Model",
      placeHolder: "Choose a model from the current catalog",
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (!selection) { return; }

    // Preserve an existing override's scope. New choices apply to the repository
    // folder, or to the workspace/user when no matching folder is open.
    const inspected = config.inspect<string>("commitMessageModel");
    const folder = resource ? vscode.workspace.getWorkspaceFolder(resource) : undefined;
    let target: vscode.ConfigurationTarget;
    if (inspected?.workspaceFolderValue !== undefined && folder) {
      target = vscode.ConfigurationTarget.WorkspaceFolder;
    } else if (inspected?.workspaceValue !== undefined) {
      target = vscode.ConfigurationTarget.Workspace;
    } else if (inspected?.globalValue !== undefined) {
      target = vscode.ConfigurationTarget.Global;
    } else if (folder) {
      target = vscode.ConfigurationTarget.WorkspaceFolder;
    } else if (vscode.workspace.workspaceFile || vscode.workspace.workspaceFolders?.length) {
      target = vscode.ConfigurationTarget.Workspace;
    } else {
      target = vscode.ConfigurationTarget.Global;
    }
    await config.update("commitMessageModel", selection.modelId, target);
    vscode.window.showInformationMessage(`Google Agent Platform: Commit messages will use ${selection.modelId}.`);
  } catch (error) {
    vscode.window.showErrorMessage(`Google Agent Platform: Could not select a commit-message model — ${error}`);
  }
}
