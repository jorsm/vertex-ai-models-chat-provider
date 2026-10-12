import * as vscode from "vscode";
import type { VertexChatModelDispatcher } from "../VertexChatModelDispatcher";
import { EffortCatalog, EffortError, resolveEffort } from "./Effort";
import { captureEffortPreferences, defaultEffortTarget, hasWorkspace, writeEffortPreference } from "./EffortConfiguration";

/** Model-selection row with an exact catalog ID, independent of its display label. */
interface ModelPickerItem extends vscode.QuickPickItem {
    type: "model";
    modelId: string;
}

/** Effort-selection row; the default carries its actual named level like other choices. */
interface EffortPickerItem extends vscode.QuickPickItem {
    type: "effort";
    value: string;
}

type PickerItem = ModelPickerItem | EffortPickerItem;

/** Available models and revisions captured together by the shared dispatcher. */
type ModelSnapshot = ReturnType<VertexChatModelDispatcher["getEffortModelSnapshot"]>;

/** Convenience state for the next picker opening, independent of the active Chat model. */
const LAST_CONFIGURED_MODEL_KEY = "thinkingEffort.lastConfiguredModelId";

/**
 * Owns one model/effort picker, its subscriptions, and its pending settings writes.
 *
 * @remarks
 * A session is used once. Closing it invalidates queued writes; a write already
 * handed to VS Code can still complete. Connection and catalog revisions are
 * checked by {@link validateSelection} when a queued write starts, and stale
 * choices are refreshed for reselection.
 */
export class ThinkingEffortPicker implements vscode.Disposable {
    private readonly picker: vscode.QuickPick<PickerItem>;
    private readonly scopeButton = { iconPath: new vscode.ThemeIcon("settings-gear"), tooltip: "Switch User/Workspace scope" };
    private readonly subscriptions: vscode.Disposable[] = [];
    private catalog: EffortCatalog;
    private modelId: string | undefined;
    private target = vscode.ConfigurationTarget.Global;
    private closed = false;
    private finish: (() => void) | undefined;

    /**
     * @param provider - Supplies the latest model and connection revisions before writes.
     * @param context - Stores the last successfully configured model.
     * @param state - Model snapshot captured after initial discovery.
     * @param token - Cancellation token owned by the calling command.
     */
    constructor(
        private readonly provider: Pick<VertexChatModelDispatcher, "getEffortModelSnapshot">,
        private readonly context: vscode.ExtensionContext,
        private state: ModelSnapshot,
        private readonly token: vscode.CancellationToken,
    ) {
        this.catalog = new EffortCatalog(state.models);
        this.picker = vscode.window.createQuickPick<PickerItem>();
        this.picker.matchOnDescription = true;
        this.picker.matchOnDetail = true;
    }

    /** Closes the session, invalidates queued choices, and releases UI and event subscriptions. */
    public dispose(): void {
        if (this.closed) {
            return;
        }
        this.closed = true;
        for (const subscription of this.subscriptions.splice(0)) {
            subscription.dispose();
        }
        this.picker.dispose();
        this.finish?.();
        this.finish = undefined;
    }

    /**
     * Shows models, or skips to efforts when only one configurable model is available.
     *
     * @returns Resolves when the session closes. Setup failures propagate after cleanup.
     */
    public async run(): Promise<void> {
        try {
            if (this.closed || this.token.isCancellationRequested) {
                return;
            }
            this.showModels();
            const onlyItem = this.picker.items[0];
            if (this.picker.items.length === 1 && onlyItem?.type === "model") {
                this.target = defaultEffortTarget(onlyItem.modelId);
                this.modelId = onlyItem.modelId;
                this.showEfforts();
            }
            await new Promise<void>((resolve) => {
                this.finish = resolve;
                this.subscriptions.push(
                    this.picker.onDidHide(() => this.dispose()),
                    this.picker.onDidTriggerButton((button) => this.handleButton(button)),
                    this.picker.onDidAccept(() => this.acceptSelection()),
                );
                this.picker.show();
            });
        } finally {
            this.dispose();
        }
    }

    /** Shows configurable models in catalog order and highlights the last configured model. */
    private showModels(): void {
        this.modelId = undefined;
        this.picker.title = "Thinking Effort — Choose model";
        this.picker.placeholder = "Choose the model to configure";
        this.picker.buttons = [];
        const last = this.context.workspaceState.get<string>(LAST_CONFIGURED_MODEL_KEY);
        this.picker.items = this.catalog.models.filter((model) => model.effort).map((model) => ({ type: "model", label: model.displayName, modelId: model.id, description: this.describeEffort(model.id, true) }));
        this.picker.activeItems = this.picker.items.filter((item) => item.type === "model" && item.modelId === last);
    }

    /** Shows each named level once, marking the catalog default and current effective choice. */
    private showEfforts(): void {
        const model = this.modelId === undefined ? undefined : this.catalog.get(this.modelId);
        if (!model?.effort) {
            this.showModels();
            return;
        }
        const effort = model.effort;
        const scope = this.target === vscode.ConfigurationTarget.Workspace ? "Workspace" : "User";
        const workspaceAvailable = hasWorkspace();
        this.scopeButton.tooltip = workspaceAvailable ? `Scope: ${scope}. Switch to ${scope === "User" ? "Workspace" : "User"}` : "Scope: User. Workspace unavailable until a workspace is open";
        this.picker.title = `Thinking Effort — ${model.displayName} — ${scope}`;
        this.picker.placeholder = `Current: ${this.describeEffort(model.id)}. Applies to your next request.`;
        this.picker.buttons = workspaceAvailable
            ? [
                  vscode.QuickInputButtons.Back,
                  this.scopeButton,
              ]
            : [vscode.QuickInputButtons.Back];
        let current: string | undefined;
        try {
            current = resolveEffort(this.catalog, model.id, captureEffortPreferences()).effort?.value;
        } catch {
            // Keep choices available so an invalid setting can be replaced.
        }
        this.picker.items = effort.values.map((value) => ({
            type: "effort",
            label: formatEffortLabel(value),
            ...(value === effort.default ? { description: "Default" } : {}),
            value,
        }));
        this.picker.activeItems = this.picker.items.filter((item) => item.type === "effort" && item.value === current);
    }

    /**
     * Describes the current choice or a recoverable settings error without hiding the model.
     *
     * @param id - Exact model ID to resolve against this session's catalog.
     * @param compact - Whether to use a short error for the model-list description.
     * @returns A human-readable effort level or an invalid-setting message.
     */
    private describeEffort(id: string, compact = false): string {
        try {
            const request = resolveEffort(this.catalog, id, captureEffortPreferences());
            return formatEffortLabel(request.effort?.value ?? "");
        } catch (error) {
            if (compact) {
                return "Invalid setting";
            }
            const message = error instanceof Error ? error.message : String(error);
            return `Invalid: ${message}`;
        }
    }

    /** Navigates Back or switches write scope; controls are ignored while a write is pending. */
    private handleButton(button: vscode.QuickInputButton): void {
        if (this.closed || this.picker.busy) {
            return;
        }
        if (button === vscode.QuickInputButtons.Back) {
            this.showModels();
        } else if (button === this.scopeButton && hasWorkspace()) {
            this.target = this.target === vscode.ConfigurationTarget.Global ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
            this.showEfforts();
        }
    }

    /** Selects a model or persists a named effort, reporting recoverable failures in the open picker. */
    private async acceptSelection(): Promise<void> {
        if (this.closed || this.picker.busy) {
            return;
        }
        const item = this.picker.selectedItems[0];
        if (!item) {
            return;
        }
        if (item.type === "model") {
            try {
                this.target = defaultEffortTarget(item.modelId);
                this.modelId = item.modelId;
                this.showEfforts();
            } catch (error) {
                this.reportError(error);
            }
            return;
        }
        const selectedId = this.modelId;
        if (selectedId === undefined) {
            return;
        }
        this.picker.busy = true;
        this.picker.enabled = false;
        try {
            await writeEffortPreference(selectedId, item.value, this.target, () => this.validateSelection(selectedId, item.value));
            if (this.closed || this.token.isCancellationRequested) {
                return;
            }
            await this.context.workspaceState.update(LAST_CONFIGURED_MODEL_KEY, selectedId);
            if (!this.closed && !this.token.isCancellationRequested) {
                this.picker.hide();
            }
        } catch (error) {
            if (!this.closed && !this.token.isCancellationRequested) {
                this.reportError(error);
                this.showEfforts();
            }
        } finally {
            if (!this.closed) {
                this.picker.busy = false;
                this.picker.enabled = true;
            }
        }
    }

    /**
     * Rechecks session lifetime, revisions, and choice membership when a queued write starts.
     *
     * @param id - Model ID captured when the user accepted an effort row.
     * @param value - Named effort captured from that row.
     * @throws A {@link vscode.CancellationError} if the session has closed or been canceled.
     * @throws An {@link EffortError} if choices are stale or the selected value is unsupported.
     */
    private validateSelection(id: string, value: string): void {
        if (this.closed || this.token.isCancellationRequested) {
            throw new vscode.CancellationError();
        }
        const latest = this.provider.getEffortModelSnapshot();
        if (latest.connectionRevision !== this.state.connectionRevision || latest.catalogRevision !== this.state.catalogRevision) {
            const catalog = new EffortCatalog(latest.models);
            this.state = latest;
            this.catalog = catalog;
            throw new EffortError("stale", "The connection or catalog changed. Choices have been refreshed; select again.");
        }
        resolveEffort(this.catalog, id, { preferences: { [id]: value }, sourceByModel: {} });
    }

    /** Reports an actionable settings or persistence error without rejecting the event callback. */
    private reportError(error: unknown): void {
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`Google Agent Platform: ${message}`);
    }
}

/** Formats a catalog value for display while preserving the literal value in picker payloads. */
function formatEffortLabel(value: string): string {
    if (value === "xhigh") {
        return "Extra high";
    }
    return value.charAt(0).toUpperCase() + value.slice(1);
}
