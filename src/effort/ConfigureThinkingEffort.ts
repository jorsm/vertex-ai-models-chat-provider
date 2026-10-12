import * as vscode from "vscode";
import type { VertexChatModelDispatcher } from "../VertexChatModelDispatcher";
import { ThinkingEffortPicker } from "./ThinkingEffortPicker";

/**
 * Loads discovered models and owns one thinking-effort configuration session.
 *
 * @remarks
 * Another invocation cancels the previous discovery or picker session. The
 * {@link ThinkingEffortPicker} owns navigation, revision checks, and persistence.
 * Discovery and picker failures are reported through notifications.
 */
export class ConfigureThinkingEffort implements vscode.Disposable {
    /** Cancels the discovery or picker session currently owned by this command. */
    private cancel: (() => void) | undefined;

    /**
     * @param provider - Supplies bounded discovery and revisioned model snapshots.
     * @param context - Stores the last configured model as workspace convenience state.
     */
    constructor(
        private readonly provider: Pick<VertexChatModelDispatcher, "getEffortModelSnapshot" | "ensureInitialDiscovery">,
        private readonly context: vscode.ExtensionContext,
    ) {}

    /** Cancels the current session and releases its picker resources. */
    public dispose(): void {
        this.cancel?.();
    }

    /**
     * Presents discovered model choices and their catalog-owned effort levels.
     *
     * @returns Resolves when the picker closes, discovery is canceled, or a failure
     * or a catalog without configurable effort is reported.
     */
    public async run(): Promise<void> {
        this.cancel?.();
        const source = new vscode.CancellationTokenSource();
        let session: ThinkingEffortPicker | undefined;
        const cancel = () => {
            source.cancel();
            session?.dispose();
        };
        this.cancel = cancel;
        try {
            await this.discoverModels(source);
            if (source.token.isCancellationRequested) {
                return;
            }
            const state = this.provider.getEffortModelSnapshot();
            if (!state.models.some((model) => model.effort)) {
                void vscode.window.showInformationMessage("Google Agent Platform: The discovered catalog has no configurable thinking effort.");
                return;
            }
            session = new ThinkingEffortPicker(this.provider, this.context, state, source.token);
            await session.run();
        } catch (error) {
            if (!source.token.isCancellationRequested) {
                const message = error instanceof Error ? error.message : String(error);
                void vscode.window.showErrorMessage(`Google Agent Platform: Could not configure thinking effort — ${message}`);
            }
        } finally {
            session?.dispose();
            source.cancel();
            source.dispose();
            if (this.cancel === cancel) {
                this.cancel = undefined;
            }
        }
    }

    /**
     * Connects progress cancellation to this invocation's discovery wait.
     *
     * @param source - Cancellation source owned by the current command run.
     * @returns Resolves after initial discovery; discovery failures propagate to the command.
     */
    private async discoverModels(source: vscode.CancellationTokenSource): Promise<void> {
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Loading thinking effort models", cancellable: true }, async (_progress, token) => {
            const subscription = token.onCancellationRequested(() => source.cancel());
            try {
                if (token.isCancellationRequested) {
                    source.cancel();
                }
                await this.provider.ensureInitialDiscovery(source.token);
            } finally {
                subscription.dispose();
            }
        });
    }
}
