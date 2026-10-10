import * as vscode from "vscode";
import { EffortError, type EffortPreferenceSnapshot, snapshot } from "./Effort";

const KEY = "thinkingEffortByModel";
/** Reads a settings object without validating individual choices; an absent scope contributes no entries. */
function object(value: unknown): Record<string, unknown> {
    if (value === undefined) {
        return {};
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new EffortError("invalid-preference", "vertexAiChat.thinkingEffortByModel must be an object keyed by model ID.");
    }
    return value as Record<string, unknown>;
}
/**
 * Captures the applicable User/Remote and Workspace settings without an editor resource URI.
 * Workspace entries override User entries per model; values stay unknown until request resolution.
 * Call before awaiting other work so a public invocation retains its initial settings.
 *
 * @returns A detached, frozen snapshot of effective values and their supplying scopes.
 * @throws {EffortError} If the effective setting or an inspected scope is not an object.
 */
export function captureEffortPreferences(): EffortPreferenceSnapshot {
    const config = vscode.workspace.getConfiguration("vertexAiChat");
    const inspected = config.inspect(KEY);
    // inspect.globalValue is the applicable User/Remote layer, with no editor URI.
    const user = object(inspected?.globalValue);
    const workspace = object(inspected?.workspaceValue);
    const effective = object(config.get(KEY, {}));
    const preferences = { ...effective, ...user, ...workspace };
    const sourceByModel: Record<string, "user" | "workspace"> = Object.fromEntries(
        Object.keys(preferences).map((id) => [
            id,
            Object.hasOwn(workspace, id) ? "workspace" : "user",
        ]),
    );
    return snapshot({ preferences, sourceByModel });
}
/** Chooses Workspace when that model already has a Workspace key; otherwise new choices are saved to User. */
export function defaultEffortTarget(id: string): vscode.ConfigurationTarget {
    const workspace = object(vscode.workspace.getConfiguration("vertexAiChat").inspect(KEY)?.workspaceValue);
    return Object.hasOwn(workspace, id) ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
}
/** Whether a workspace file or folder is open, allowing a Workspace-scoped preference write. */
export function hasWorkspace(): boolean {
    return Boolean(vscode.workspace.workspaceFile || vscode.workspace.workspaceFolders?.length);
}

/** Shared queue prevents concurrent updates from losing another model's key; failed writes do not stop it. */
let writes: Promise<void> = Promise.resolve();

/**
 * Queues a change to one model's key and rereads the target scope when that write starts.
 * Other keys and scopes are preserved; removing a key allows a lower scope or catalog default to apply.
 * The caller supplies choice and revision checks, since this settings adapter does not load catalogs.
 *
 * @param id Exact catalog model ID to update.
 * @param value Named effort to save, or undefined to remove only this scope's key.
 * @param target User (Global) or Workspace; Workspace requires an open workspace.
 * @param validate Synchronous guard run after earlier writes finish and before reading or updating settings.
 * @returns Resolves when VS Code persists the update; rejects on guard, scope, settings or persistence errors.
 */
export function writeEffortPreference(id: string, value: string | undefined, target: vscode.ConfigurationTarget, validate: () => void = () => {}): Promise<void> {
    const write = writes
        .catch(() => {})
        .then(async () => {
            validate();
            if (target !== vscode.ConfigurationTarget.Global && (target !== vscode.ConfigurationTarget.Workspace || !hasWorkspace())) {
                throw new EffortError("invalid-preference", "Workspace thinking effort requires an open workspace.");
            }
            const config = vscode.workspace.getConfiguration("vertexAiChat");
            const inspected = config.inspect(KEY);
            const next = { ...object(target === vscode.ConfigurationTarget.Workspace ? inspected?.workspaceValue : inspected?.globalValue) };
            if (value === undefined) {
                delete next[id];
            } else {
                Object.defineProperty(next, id, { value, enumerable: true, configurable: true, writable: true });
            }
            await config.update(KEY, next, target);
        });
    writes = write;
    return write;
}
