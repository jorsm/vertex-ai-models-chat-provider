import * as vscode from "vscode";

/**
 * Resource context accepted by the commit-message commands.
 *
 * @remarks
 * SCM title actions supply a source-control instance; programmatic callers
 * may supply a repository or file URI directly.
 */
export type CommitMessageCommandContext = vscode.Uri | vscode.SourceControl;

/**
 * Resolves the resource used by both commit-message commands.
 *
 * @remarks
 * An explicit URI or SCM root takes precedence over the active editor URI,
 * followed by the first workspace folder. Generation resolves the resulting
 * URI to a Git repository; selection uses it to scope the model setting.
 *
 * @param context - A resource URI, an SCM provider, or no explicit context.
 * @returns The explicit or inferred resource, or `undefined` when none is available.
 */
export function resolveCommitMessageResourceUri(context?: CommitMessageCommandContext): vscode.Uri | undefined {
    const resource = context && "rootUri" in context ? context.rootUri : context;
    return resource ?? vscode.window.activeTextEditor?.document.uri ?? vscode.workspace.workspaceFolders?.[0]?.uri;
}
