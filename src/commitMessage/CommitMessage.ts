import * as vscode from "vscode";
import type { VertexChatModelDispatcher } from "../VertexChatModelDispatcher";
import { Logger } from "../utils/Logger";
import { resolveCommitMessageResourceUri } from "./CommitMessageContext";
import type { CommitMessageCommandContext } from "./CommitMessageContext";
import { collectStagedDiff, getGitAPI, resolveRepository } from "./CommitMessageGit";
import type { GitRepository } from "./CommitMessageGit";
import { createCommitMessageMessages, DEFAULT_SYSTEM_PROMPT } from "./CommitMessagePrompts";

/** Shared inference contract required by this command. */
type CommitMessageProvider = Pick<VertexChatModelDispatcher, "infer">;

const logger = new Logger("CommitMessage");

/** Repositories with an invocation in progress, including staged-diff collection. */
const activeRepositories = new WeakSet<GitRepository>();

/**
 * Generates a message from staged changes and writes it to the repository's SCM input box.
 *
 * @remarks
 * Handles `vertexAiChat.generateCommitMessage`. Both commit-message commands
 * use {@link resolveCommitMessageResourceUri} to choose their resource.
 * Repository lookup and staged-diff reads are delegated to the Git module.
 *
 * Only one invocation per repository runs at a time. Existing input is kept
 * throughout generation and on failure or cancellation. A successful result
 * replaces it only if the user has not edited the input during this invocation.
 * All command failures are logged; cancellation suppresses the error notification.
 *
 * @param provider - Shared inference entry point for the configured model.
 * @param context - Repository or file URI, or the SCM provider invoking the command.
 * @returns Resolves after generation finishes or a precondition or handled failure ends the command.
 */
export async function generateCommitMessage(provider: CommitMessageProvider, context?: CommitMessageCommandContext): Promise<void> {
    try {
        const git = await getGitAPI();
        if (!git) {
            const remoteContext = vscode.env.remoteName ? ` in this ${vscode.env.remoteName} remote window` : " in this extension host";
            void vscode.window.showWarningMessage(`Google Agent Platform: Commit-message generation is unavailable${remoteContext} because the Git extension API cannot be reached.`);
            return;
        }

        const repository = resolveRepository(git, resolveCommitMessageResourceUri(context));
        if (!repository) {
            void vscode.window.showWarningMessage("Google Agent Platform: No Git repository found for the selected resource.");
            return;
        }
        if (activeRepositories.has(repository)) {
            void vscode.window.showInformationMessage("Google Agent Platform: A commit message is already being generated for this repository.");
            return;
        }

        activeRepositories.add(repository);
        try {
            await generateForRepository(provider, repository);
        } finally {
            activeRepositories.delete(repository);
        }
    } catch (error) {
        logger.error("Commit-message generation failed", error);
        if (!(error instanceof vscode.CancellationError)) {
            const message = error instanceof Error ? error.message : String(error);
            void vscode.window.showErrorMessage(`Google Agent Platform: Failed to generate commit message — ${message}`);
        }
    }
}

/**
 * Collects the complete staged diff, invokes inference, and applies an unchanged-input result.
 *
 * @remarks
 * Uses the effective repository-scoped model and prompt settings. A blank custom
 * prompt uses {@link DEFAULT_SYSTEM_PROMPT}. Model availability and routing remain
 * the responsibility of {@link VertexChatModelDispatcher.infer}; no model fallback is attempted.
 *
 * @param provider - Inference entry point for the selected model.
 * @param repository - Repository locked by {@link generateCommitMessage}.
 * @returns Resolves after the result is applied or a precondition or edited input prevents it.
 * @throws Diff-read and inference errors, which the command handler reports.
 */
async function generateForRepository(provider: CommitMessageProvider, repository: GitRepository): Promise<void> {
    const changes = [...repository.state.indexChanges];
    if (changes.length === 0) {
        void vscode.window.showInformationMessage("Google Agent Platform: No staged changes found. Please stage files before generating a commit message.");
        return;
    }

    const config = vscode.workspace.getConfiguration("vertexAiChat", repository.rootUri);
    const modelId = config.get<string>("commitMessageModel")?.trim();
    if (!modelId) {
        void vscode.window.showErrorMessage("Google Agent Platform: Set 'vertexAiChat.commitMessageModel' in user, workspace, or folder settings before generating a commit message.");
        return;
    }
    const systemPrompt = config.get<string>("commitMessagePrompt")?.trim() || DEFAULT_SYSTEM_PROMPT;
    const originalInput = repository.inputBox.value;
    const diff = await collectStagedDiff(repository, changes);
    if (!diff) {
        void vscode.window.showInformationMessage("Google Agent Platform: All staged diffs are empty.");
        return;
    }

    logger.log(`── Sending ${diff.length} chars of diff to configured model '${modelId}'…`);
    const messages = createCommitMessageMessages(diff, systemPrompt);
    const commitMessage = await requestCommitMessage(provider, repository, modelId, messages);
    logger.log(`✅ Generated: ${commitMessage}`);
    if (repository.inputBox.value !== originalInput) {
        void vscode.window.showWarningMessage("Google Agent Platform: The commit message was edited during generation. Your edits were kept.");
        return;
    }
    repository.inputBox.value = commitMessage;
}

/**
 * Accumulates streamed text under a cancellable progress notification.
 *
 * @remarks
 * The notification's token is passed directly to inference. Non-text response
 * parts are ignored, and cancellation is checked before and after inference.
 *
 * @param provider - Shared inference entry point.
 * @param repository - Supplies the root URI for request-scoped configuration and labels.
 * @param modelId - Exact configured model ID to invoke.
 * @param messages - System and diff messages built by {@link createCommitMessageMessages}.
 * @returns The trimmed, non-empty commit message.
 * @throws {@link vscode.CancellationError} if cancellation is requested.
 * @throws Inference failures or an error when the model returns no usable text.
 */
async function requestCommitMessage(provider: CommitMessageProvider, repository: GitRepository, modelId: string, messages: readonly vscode.LanguageModelChatRequestMessage[]): Promise<string> {
    return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Generating commit message", cancellable: true }, async (_progress, token) => {
        if (token.isCancellationRequested) {
            throw new vscode.CancellationError();
        }
        const parts: string[] = [];
        const progress: vscode.Progress<vscode.LanguageModelResponsePart> = {
            report(part) {
                if (part instanceof vscode.LanguageModelTextPart) {
                    parts.push(part.value);
                }
            },
        };
        await provider.infer(modelId, messages, { tools: [], toolMode: vscode.LanguageModelChatToolMode.Auto }, progress, token, repository.rootUri);
        if (token.isCancellationRequested) {
            throw new vscode.CancellationError();
        }
        const message = parts.join("").trim();
        if (!message) {
            throw new Error("The model returned an empty commit message.");
        }
        return message;
    });
}
