import * as vscode from "vscode";
import { EffortError, snapshot } from "./Effort";
import type { EffortPreferenceSnapshot, EffortPreferenceSource } from "./Effort";

const EFFORT_SETTING_KEY = "thinkingEffortByModel";

/** Settled queue tail; each caller still receives its own write's success or failure. */
let preferenceWriteQueue: Promise<void> = Promise.resolve();

/**
 * Captures the applicable User/Remote and Workspace settings without an editor resource URI.
 *
 * @remarks
 * Workspace entries override User entries per model; values stay unknown until request resolution.
 * Call before awaiting other work so a public invocation retains its initial settings.
 *
 * @returns A detached, frozen snapshot of effective values and their supplying scopes.
 * @throws An {@link EffortError} if the effective setting or an inspected scope is not an object.
 */
export function captureEffortPreferences(): EffortPreferenceSnapshot {
    const config = vscode.workspace.getConfiguration("vertexAiChat");
    const inspected = config.inspect(EFFORT_SETTING_KEY);
    // inspect.globalValue is the applicable User/Remote layer, with no editor URI.
    const user = readPreferenceObject(inspected?.globalValue);
    const workspace = readPreferenceObject(inspected?.workspaceValue);
    const effective = readPreferenceObject(config.get(EFFORT_SETTING_KEY, {}));
    const preferences = { ...effective, ...user, ...workspace };
    const sourceByModel: Record<string, EffortPreferenceSource> = Object.fromEntries(
        Object.keys(preferences).map((id) => [
            id,
            Object.hasOwn(workspace, id) ? "workspace" : "user",
        ]),
    );
    return snapshot({ preferences, sourceByModel });
}
/**
 * Chooses the initial write scope for a model.
 *
 * @param id - Exact catalog model ID to inspect.
 * @returns Workspace if it owns the model's key; otherwise User (Global).
 * @throws An {@link EffortError} if the Workspace setting is not an object.
 */
export function defaultEffortTarget(id: string): vscode.ConfigurationTarget {
    const workspace = readPreferenceObject(vscode.workspace.getConfiguration("vertexAiChat").inspect(EFFORT_SETTING_KEY)?.workspaceValue);
    return Object.hasOwn(workspace, id) ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
}
/**
 * Checks whether Workspace-scoped preferences can be saved.
 *
 * @returns Whether a workspace file or at least one workspace folder is open.
 */
export function hasWorkspace(): boolean {
    return Boolean(vscode.workspace.workspaceFile || vscode.workspace.workspaceFolders?.length);
}

/**
 * Queues a change to one model's key and rereads the target scope when that write starts.
 *
 * @remarks
 * Other keys and scopes are preserved; removing a key allows a lower scope or catalog default to apply.
 * The caller supplies choice and revision checks, since this settings adapter does not load catalogs.
 * Failed writes reject their caller without blocking later writes.
 *
 * @param id - Exact catalog model ID to update.
 * @param value - Named effort to save, or `undefined` to remove only this scope's key.
 * @param target - User (Global) or Workspace; Workspace requires an open workspace.
 * @param validate - Synchronous guard run after earlier writes finish and before reading or updating settings.
 * @returns Resolves when VS Code persists the update; rejects on guard, scope, settings or persistence errors.
 * @throws An {@link EffortError} if the scope is unsupported, Workspace is unavailable,
 * or the target scope's setting is malformed. Guard and persistence errors propagate unchanged.
 */
export function writeEffortPreference(id: string, value: string | undefined, target: vscode.ConfigurationTarget, validate: () => void = () => {}): Promise<void> {
    const write = preferenceWriteQueue.then(() => updateEffortPreference(id, value, target, validate));
    preferenceWriteQueue = write.then(
        () => undefined,
        () => undefined,
    );
    return write;
}

/** Validates the current scope and changes only the requested key after earlier writes finish. */
async function updateEffortPreference(id: string, value: string | undefined, target: vscode.ConfigurationTarget, validate: () => void): Promise<void> {
    validate();
    if (target !== vscode.ConfigurationTarget.Global && target !== vscode.ConfigurationTarget.Workspace) {
        throw new EffortError("invalid-preference", "Thinking effort preferences can only be saved to User or Workspace settings.");
    }
    if (target === vscode.ConfigurationTarget.Workspace && !hasWorkspace()) {
        throw new EffortError("invalid-preference", "Workspace thinking effort requires an open workspace.");
    }
    const config = vscode.workspace.getConfiguration("vertexAiChat");
    const inspected = config.inspect(EFFORT_SETTING_KEY);
    const scopeValue = target === vscode.ConfigurationTarget.Workspace ? inspected?.workspaceValue : inspected?.globalValue;
    const next = { ...readPreferenceObject(scopeValue) };
    if (value === undefined) {
        delete next[id];
    } else {
        // Define an own property even when a literal model ID is "__proto__".
        Object.defineProperty(next, id, { value, enumerable: true, configurable: true, writable: true });
    }
    await config.update(EFFORT_SETTING_KEY, next, target);
}

/**
 * Reads a settings object without validating individual effort choices.
 *
 * @param value - Raw VS Code setting or inspected scope value.
 * @returns The supplied object, or an empty object for an absent scope.
 * @throws An {@link EffortError} if the value is null, an array, or a primitive.
 */
function readPreferenceObject(value: unknown): Record<string, unknown> {
    if (value === undefined) {
        return {};
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new EffortError("invalid-preference", "vertexAiChat.thinkingEffortByModel must be an object keyed by model ID.");
    }
    return value as Record<string, unknown>;
}
