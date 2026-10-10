import * as vscode from "vscode";
import { EffortError, EffortPreference, EffortPreferenceSnapshot, snapshot } from "./EffortTypes";

const KEY = "thinkingEffortByModel";
function object(value: unknown): Record<string, unknown> {
  if (value === undefined) { return {}; }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new EffortError("invalid-preference", "vertexAiChat.thinkingEffortByModel must be an object keyed by canonical model ID.");
  }
  return value as Record<string, unknown>;
}
export function captureEffortPreferences(): EffortPreferenceSnapshot {
  const config = vscode.workspace.getConfiguration("vertexAiChat");
  const inspected = config.inspect(KEY);
  // inspect.globalValue is the applicable User/Remote layer, with no editor URI.
  const user = object(inspected?.globalValue);
  const workspace = object(inspected?.workspaceValue);
  const effective = object(config.get(KEY, {}));
  const preferences = { ...effective, ...user, ...workspace };
  const sourceByModel: Record<string, "user" | "workspace"> = Object.fromEntries(Object.keys(preferences).map((id) => [id,
    Object.hasOwn(workspace, id) ? "workspace" : "user"]));
  return snapshot({ preferences, sourceByModel });
}
export function defaultEffortTarget(id: string): vscode.ConfigurationTarget {
  const workspace = object(vscode.workspace.getConfiguration("vertexAiChat").inspect(KEY)?.workspaceValue);
  return Object.hasOwn(workspace, id) ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
}
export function hasWorkspace(): boolean { return Boolean(vscode.workspace.workspaceFile || vscode.workspace.workspaceFolders?.length); }

let writes: Promise<void> = Promise.resolve();
export function writeEffortPreference(id: string, value: EffortPreference | undefined, target: vscode.ConfigurationTarget, validate: () => void = () => {}): Promise<void> {
  const write = writes.catch(() => {}).then(async () => {
    validate();
    if (target !== vscode.ConfigurationTarget.Global && (target !== vscode.ConfigurationTarget.Workspace || !hasWorkspace())) {
      throw new EffortError("invalid-preference", "Workspace thinking effort requires an open workspace.");
    }
    const config = vscode.workspace.getConfiguration("vertexAiChat");
    const inspected = config.inspect(KEY);
    const next = { ...object(target === vscode.ConfigurationTarget.Workspace ? inspected?.workspaceValue : inspected?.globalValue) };
    if (value === undefined) { delete next[id]; } else { Object.defineProperty(next, id, { value, enumerable: true, configurable: true, writable: true }); }
    await config.update(KEY, next, target);
  });
  writes = write;
  return write;
}
