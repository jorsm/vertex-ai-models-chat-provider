import * as vscode from "vscode";
import type { VertexChatModelDispatcher } from "../VertexChatModelDispatcher";
import { EffortCatalog } from "./EffortCatalog";
import { captureEffortPreferences, defaultEffortTarget, hasWorkspace, writeEffortPreference } from "./EffortConfiguration";
import { EffortError } from "./EffortTypes";
import { resolveEffort } from "./ResolveEffort";

interface Item extends vscode.QuickPickItem {
    modelId?: string;
    value?: string;
}
const LAST = "thinkingEffort.lastConfiguredModelId";

/** One owned picker/session; invoking the command again cancels the previous session. */
export class ConfigureThinkingEffort implements vscode.Disposable {
    private cancel: (() => void) | undefined;
    constructor(
        private readonly provider: Pick<VertexChatModelDispatcher, "getEffortModelSnapshot" | "ensureInitialDiscovery">,
        private readonly context: vscode.ExtensionContext,
    ) {}
    dispose(): void {
        this.cancel?.();
    }
    async run(): Promise<void> {
        this.cancel?.();
        const source = new vscode.CancellationTokenSource();
        let picker: vscode.QuickPick<Item> | undefined;
        const cancel = () => {
            source.cancel();
            picker?.hide();
        };
        this.cancel = cancel;
        try {
            await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Loading thinking effort models", cancellable: true }, async (_progress, token) => {
                const subscription = token.onCancellationRequested(() => source.cancel());
                try {
                    await this.provider.ensureInitialDiscovery(source.token);
                } finally {
                    subscription.dispose();
                }
            });
            if (source.token.isCancellationRequested) {
                return;
            }
            let state = this.provider.getEffortModelSnapshot();
            let catalog = new EffortCatalog(state.models);
            if (!state.models.some((model) => model.effort)) {
                void vscode.window.showInformationMessage("Google Agent Platform: The discovered catalog has no configurable thinking effort.");
                return;
            }
            picker = vscode.window.createQuickPick<Item>();
            const pick = picker;
            pick.matchOnDescription = true;
            pick.matchOnDetail = true;
            const scopeButton = { iconPath: new vscode.ThemeIcon("settings-gear"), tooltip: "Switch User/Workspace scope" };
            let modelId: string | undefined;
            let target = vscode.ConfigurationTarget.Global;
            const effortLabel = (value: string): string => (value === "xhigh" ? "Extra high" : value.charAt(0).toUpperCase() + value.slice(1));
            const description = (id: string, compact = false): string => {
                try {
                    const preferences = captureEffortPreferences();
                    const request = resolveEffort(catalog, id, preferences);
                    const label = effortLabel(request.effort?.value ?? "");
                    return label;
                } catch (error) {
                    return compact ? "Invalid setting" : `Invalid: ${error instanceof Error ? error.message : error}`;
                }
            };
            const models = () => {
                modelId = undefined;
                pick.title = "Thinking Effort — Choose model";
                pick.placeholder = "Choose the model to configure";
                pick.buttons = [];
                const last = this.context.workspaceState.get<string>(LAST);
                pick.items = state.models.filter((model) => model.effort).map((model) => ({ label: model.displayName, modelId: model.id, description: description(model.id, true) }));
                pick.activeItems = pick.items.filter((item) => item.modelId === last);
            };
            const efforts = () => {
                const model = catalog.get(modelId!);
                if (!model?.effort) {
                    models();
                    return;
                }
                const scope = target === vscode.ConfigurationTarget.Workspace ? "Workspace" : "User";
                scopeButton.tooltip = hasWorkspace() ? `Scope: ${scope}. Switch to ${scope === "User" ? "Workspace" : "User"}` : "Scope: User. Workspace unavailable until a workspace is open";
                pick.title = `Thinking Effort — ${model.displayName} — ${scope}`;
                pick.placeholder = `Current: ${description(model.id)}. Applies to your next request.`;
                pick.buttons = hasWorkspace() ? [vscode.QuickInputButtons.Back, scopeButton] : [vscode.QuickInputButtons.Back];
                let current: unknown;
                try {
                    current = resolveEffort(catalog, model.id, captureEffortPreferences()).effort?.value;
                } catch {
                    /* Keep choices available so an invalid setting can be replaced. */
                }
                pick.items = model.effort.values.map((value) => ({
                    label: effortLabel(value),
                    ...(value === model.effort!.default ? { description: "Default" } : {}),
                    value,
                }));
                pick.activeItems = pick.items.filter((item) => item.value === current);
            };
            models();
            const onlyItem = pick.items[0];
            if (pick.items.length === 1 && onlyItem?.modelId) {
                modelId = onlyItem.modelId;
                target = defaultEffortTarget(modelId);
                efforts();
            }
            await new Promise<void>((resolve) => {
                const subscriptions: vscode.Disposable[] = [];
                subscriptions.push(
                    pick.onDidHide(() => {
                        source.cancel();
                        subscriptions.forEach((sub) => sub.dispose());
                        resolve();
                    }),
                );
                subscriptions.push(
                    pick.onDidTriggerButton((button) => {
                        if (pick.busy) {
                            return;
                        }
                        if (button === vscode.QuickInputButtons.Back) {
                            models();
                        } else if (hasWorkspace()) {
                            target = target === vscode.ConfigurationTarget.Global ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
                            efforts();
                        }
                    }),
                );
                subscriptions.push(
                    pick.onDidAccept(async () => {
                        if (pick.busy) {
                            return;
                        }
                        const item = pick.selectedItems[0];
                        if (!item) {
                            return;
                        }
                        if (!modelId) {
                            try {
                                target = defaultEffortTarget(item.modelId!);
                                modelId = item.modelId;
                                efforts();
                            } catch (error) {
                                void vscode.window.showErrorMessage(`Google Agent Platform: ${error instanceof Error ? error.message : error}`);
                            }
                            return;
                        }
                        const selectedId = modelId;
                        const validate = () => {
                            if (source.token.isCancellationRequested) {
                                throw new vscode.CancellationError();
                            }
                            const latest = this.provider.getEffortModelSnapshot();
                            if (latest.connectionRevision !== state.connectionRevision || latest.catalogRevision !== state.catalogRevision) {
                                state = latest;
                                catalog = new EffortCatalog(state.models);
                                throw new EffortError("stale", "The connection or catalog changed. Choices have been refreshed; select again.");
                            }
                            resolveEffort(catalog, selectedId, { preferences: { [selectedId]: item.value }, sourceByModel: {} });
                        };
                        pick.busy = true;
                        pick.enabled = false;
                        try {
                            await writeEffortPreference(selectedId, item.value, target, validate);
                            await this.context.workspaceState.update(LAST, selectedId);
                            pick.hide();
                        } catch (error) {
                            if (!source.token.isCancellationRequested) {
                                void vscode.window.showErrorMessage(`Google Agent Platform: ${error instanceof Error ? error.message : error}`);
                                efforts();
                            }
                        } finally {
                            pick.busy = false;
                            pick.enabled = true;
                        }
                    }),
                );
                pick.show();
            });
        } catch (error) {
            if (!source.token.isCancellationRequested) {
                void vscode.window.showErrorMessage(`Google Agent Platform: Could not configure thinking effort — ${error}`);
            }
        } finally {
            picker?.dispose();
            source.dispose();
            if (this.cancel === cancel) {
                this.cancel = undefined;
            }
        }
    }
}
