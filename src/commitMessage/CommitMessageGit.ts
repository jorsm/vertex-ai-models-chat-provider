import { relative } from "node:path";
import * as vscode from "vscode";
import { Logger } from "../utils/Logger";

/** Staged file reference supplied by the built-in Git extension. */
export interface GitChange {
    readonly uri: vscode.Uri;
}

/** Git repository members used by commit-message generation. */
export interface GitRepository {
    readonly rootUri: vscode.Uri;
    readonly state: { readonly indexChanges: readonly GitChange[] };
    readonly inputBox: { value: string };
    diffIndexWithHEAD(path: string): Promise<string>;
}

/** Version 1 Git API members used to locate repositories. */
interface GitAPI {
    readonly repositories: readonly GitRepository[];
    getRepository(resource: vscode.Uri): GitRepository | null | undefined;
}

/** Exports exposed after the built-in Git extension has activated. */
interface GitExtension {
    getAPI(version: 1): GitAPI;
}

const logger = new Logger("CommitMessageGit");

/**
 * Gets version 1 of the built-in Git extension API, activating it if needed.
 *
 * @remarks
 * Activation and API-access failures are logged and treated as an unavailable API.
 *
 * @returns The Git API, or `undefined` if the extension or its API is unavailable.
 */
export async function getGitAPI(): Promise<GitAPI | undefined> {
    try {
        const extension = vscode.extensions.getExtension<GitExtension>("vscode.git");
        if (!extension) {
            return undefined;
        }
        const exports = extension.isActive ? extension.exports : await extension.activate();
        return exports.getAPI(1);
    } catch (error) {
        logger.error("Git extension API activation failed", error);
        return undefined;
    }
}

/**
 * Resolves the selected resource to its Git repository.
 *
 * @remarks
 * A resource that does not belong to a repository does not fall back to an
 * unrelated repository. The first open repository is used only without a resource.
 *
 * @param git - The built-in Git API returned by {@link getGitAPI}.
 * @param resource - Explicit or inferred command resource.
 * @returns The matching repository, or `undefined` if none is available.
 */
export function resolveRepository(git: GitAPI, resource?: vscode.Uri): GitRepository | undefined {
    if (resource) {
        return git.getRepository(resource) ?? undefined;
    }
    return git.repositories[0];
}

/**
 * Reads and joins the staged diffs for a snapshot of repository changes.
 *
 * @remarks
 * Reads run sequentially and empty diffs are skipped. Any failed read aborts
 * collection so inference cannot silently describe only part of the staged changes.
 *
 * @param repository - Repository whose index is being read.
 * @param changes - Snapshot of staged file references for this invocation.
 * @returns Joined diffs, or an empty string when every diff is empty.
 * @throws An error identifying the file whose diff could not be read, with the original cause.
 */
export async function collectStagedDiff(repository: GitRepository, changes: readonly GitChange[]): Promise<string> {
    const paths = changes.map((change) => relative(repository.rootUri.fsPath, change.uri.fsPath));
    logger.log(`▶ generateCommitMessage — ${changes.length} staged file(s): ${paths.join(", ")}`);

    const diffs: string[] = [];
    for (const [
        index,
        change,
    ] of changes.entries()) {
        const path = relative(repository.rootUri.fsPath, change.uri.fsPath);
        logger.log(`── [${index + 1}/${changes.length}] ${path}`);
        try {
            const diff = await repository.diffIndexWithHEAD(change.uri.fsPath);
            if (diff.length > 0) {
                diffs.push(diff);
            } else {
                logger.log("   (empty diff — skipped)");
            }
        } catch (error) {
            throw new Error(`Could not read staged diff for '${path}'.`, { cause: error });
        }
    }
    return diffs.join("\n");
}
