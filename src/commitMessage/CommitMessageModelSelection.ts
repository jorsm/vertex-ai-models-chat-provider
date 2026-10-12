import * as vscode from "vscode";
import type { VertexChatModelDispatcher } from "../VertexChatModelDispatcher";
import { resolveCommitMessageResourceUri } from "./CommitMessageContext";
import type { CommitMessageCommandContext } from "./CommitMessageContext";

/**
 * Discovers models, prompts for a selection, and saves the commit-message model ID.
 *
 * @remarks
 * Handles `vertexAiChat.selectCommitMessageModel`. Both commit-message commands
 * use {@link resolveCommitMessageResourceUri} to choose their resource.
 *
 * The picker includes every discovered model and places the configured model
 * first when available. Dismissing it leaves the setting unchanged. Discovery
 * and persistence failures are reported through error notifications; an empty
 * catalog shows a warning without opening the picker.
 *
 * Preserves the most specific existing explicit setting: workspace folder,
 * workspace, then user. Without an override, writes to the matching workspace
 * folder, otherwise an open workspace, otherwise user settings. Only the model
 * ID is persisted; {@link VertexChatModelDispatcher.infer} validates availability
 * again when a commit message is generated.
 *
 * @param provider - Shared discovery entry point supplying the current available models.
 * @param context - Repository or file URI, or the SCM provider invoking the command.
 * @returns Resolves after the selection is saved, the picker is dismissed, or
 * an empty catalog or discovery/persistence failure is reported.
 */
export async function selectCommitMessageModel(provider: Pick<VertexChatModelDispatcher, "discoverModelsAndRegion">, context?: CommitMessageCommandContext): Promise<void> {
    try {
        const resource = resolveCommitMessageResourceUri(context);
        const discovered = await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: "Loading commit message models",
            },
            () => provider.discoverModelsAndRegion(),
        );
        const availableModels = discovered.availableModels;
        if (availableModels.length === 0) {
            void vscode.window.showWarningMessage("Google Agent Platform: No model is available for commit-message generation.");
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
        if (!selection) {
            return;
        }

        const target = getModelSettingTarget(config, resource);
        await config.update("commitMessageModel", selection.modelId, target);
        void vscode.window.showInformationMessage(`Google Agent Platform: Commit messages will use ${selection.modelId}.`);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`Google Agent Platform: Could not select a commit-message model — ${message}`);
    }
}

/**
 * Preserves an explicit model override's scope, or chooses the nearest open scope.
 *
 * @param config - Configuration resolved for the command resource.
 * @param resource - Resource used to find the matching workspace folder.
 * @returns The most specific existing override's target, otherwise folder, workspace, or user.
 */
function getModelSettingTarget(config: vscode.WorkspaceConfiguration, resource?: vscode.Uri): vscode.ConfigurationTarget {
    const inspected = config.inspect<string>("commitMessageModel");
    const folder = resource ? vscode.workspace.getWorkspaceFolder(resource) : undefined;
    if (inspected?.workspaceFolderValue !== undefined && folder) {
        return vscode.ConfigurationTarget.WorkspaceFolder;
    }
    if (inspected?.workspaceValue !== undefined) {
        return vscode.ConfigurationTarget.Workspace;
    }
    if (inspected?.globalValue !== undefined) {
        return vscode.ConfigurationTarget.Global;
    }
    if (folder) {
        return vscode.ConfigurationTarget.WorkspaceFolder;
    }
    if (vscode.workspace.workspaceFile || vscode.workspace.workspaceFolders?.length) {
        return vscode.ConfigurationTarget.Workspace;
    }
    return vscode.ConfigurationTarget.Global;
}
