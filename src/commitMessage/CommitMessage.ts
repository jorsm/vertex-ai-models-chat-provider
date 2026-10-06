import * as vscode from "vscode";
import type { VertexChatModelDispatcher } from "../VertexChatModelDispatcher";
import { Logger } from "../utils/Logger";

export const DEFAULT_SYSTEM_PROMPT = `You are an expert Principal Software Engineer and a strict adherent to clean Git history. Your task is to analyze \`git diff\` outputs and generate professional, highly accurate commit messages following the Conventional Commits specification.

### OBJECTIVE
Generate a single commit message based solely on the changes shown in the user's provided diff. The message must clearly communicate the *intent* of the change (the "why"), not just literal line changes.

### RULES & CONSTRAINTS

1. **Format:** <type>(<scope>): <subject>
   <BLANK LINE>
   [optional body]

2. **Types allowed:**
   - \`feat\`: A new feature
   - \`fix\`: A bug fix
   - \`refactor\`: Code change that neither fixes a bug nor adds a feature
   - \`perf\`: Code change that improves performance
   - \`style\`: Changes that do not affect the meaning of the code (white-space, formatting, etc.)
   - \`test\`: Adding missing tests or correcting existing ones
   - \`docs\`: Documentation only changes
   - \`chore\`: Changes to the build process or auxiliary tools/libraries
   - \`build\` / \`ci\`: Changes affecting build systems or CI configuration

3. **Scope Constraints:**
   - Keep the scope short, lowercase, and strictly related to the component/module changed (e.g., \`auth\`, \`ui\`, \`db\`).
   - Omit the scope entirely if the change spans across multiple independent modules or is global.

4. **Subject Line Constraints:**
   - Use the imperative, present tense: "change" not "changed" nor "changes".
   - Start with a lowercase letter.
   - Do NOT end with a period.
   - Strictly limit the subject line to 72 characters or less.

5. **Body Constraints (Use sparingly):**
   - ONLY include a body if the diff represents a complex architectural change, a non-obvious bug fix, or a major refactoring.
   - If included, focus on the *why* and *what*, rather than the *how*. 
   - Wrap lines at 72 characters.
   - Separate the subject from the body with a single blank line.

6. **Output Constraints (CRITICAL):**
   - Output ONLY the final commit message.
   - Do NOT include conversational filler like "Here is the commit message:".
   - Do NOT wrap the output in markdown code blocks (\` \`\`\` \`). Return raw text.
   - Do NOT explain your reasoning.

### EXAMPLES

**Input Diff Concept:** Added a new JWT validation function to the authentication middleware.
**Output:**
feat(auth): add JWT validation to middleware

**Input Diff Concept:** Fixed a typo in the README.md and updated the installation instructions.
**Output:**
docs: update installation instructions and fix typos

**Input Diff Concept:** Completely rewrote the caching logic for the database wrapper because it was causing memory leaks under heavy load.
**Output:**
refactor(db): rewrite caching mechanism

The previous caching implementation retained stale references to query results, causing memory exhaustion under sustained load. This introduces a proper LRU cache with strict TTL limits.`;

const getUserPrompt = (diffString: string) => `Analyze the following staged Git diff and generate a commit message based on your system instructions. 

CRITICAL: Output ONLY the raw commit message text. Do NOT wrap your response in markdown formatting or code blocks. Do NOT include conversational filler.

Git Diff:
${diffString}`;

const logger = new Logger("CommitMessage");

async function getGitAPI(): Promise<any> {
  const gitExtension = vscode.extensions.getExtension<any>("vscode.git");
  if (!gitExtension) {
    return null;
  }

  try {
    const gitExports = gitExtension.isActive ? gitExtension.exports : await gitExtension.activate();
    return gitExports?.getAPI(1) ?? null;
  } catch (error) {
    logger.log(`Git extension API activation failed: ${error}`);
    return null;
  }
}

function resolveRepository(git: any, resourceUri?: vscode.Uri): any {
  if (resourceUri) {
    return git.getRepository(resourceUri) ?? git.repositories?.[0] ?? null;
  }
  return git.repositories?.[0] ?? null;
}

export type CommitMessageCommandContext = vscode.Uri | vscode.SourceControl;

export function resolveCommitMessageResourceUri(context?: CommitMessageCommandContext): vscode.Uri | undefined {
  return context && "rootUri" in context ? context.rootUri : context;
}

/**
 * Command handler for "vertexAiChat.generateCommitMessage".
 *
 * Collects staged diffs, sends them to the LLM, and writes the generated
 * commit message into the SCM input box.
 */
export async function generateCommitMessage(provider: Pick<VertexChatModelDispatcher, "infer">, context?: CommitMessageCommandContext): Promise<void> {
  const git = await getGitAPI();
  if (!git) {
    const remoteContext = vscode.env.remoteName ? ` in this ${vscode.env.remoteName} remote window` : " in this extension host";
    vscode.window.showWarningMessage(`Vertex AI Models Chat Provider: Commit-message generation is unavailable${remoteContext} because the Git extension API cannot be reached.`);
    return;
  }

  const resourceUri = resolveCommitMessageResourceUri(context);
  const repo = resolveRepository(git, resourceUri);
  if (!repo) {
    vscode.window.showWarningMessage("Vertex AI Models Chat Provider: No Git repository found.");
    return;
  }

  const stagedChanges: any[] = repo.state.indexChanges;
  if (stagedChanges.length === 0) {
    vscode.window.showInformationMessage("Vertex AI Models Chat Provider: No staged changes found. Please stage files before generating a commit message.");
    return;
  }

  const config = vscode.workspace.getConfiguration("vertexAiChat", repo.rootUri ?? resourceUri);
  const modelId = config.get<string>("commitMessageModel")?.trim();
  if (!modelId) {
    vscode.window.showErrorMessage("Vertex AI Models Chat Provider: Set 'vertexAiChat.commitMessageModel' in user, workspace, or folder settings before generating a commit message.");
    return;
  }

  const workspaceRoot: string = repo.rootUri.fsPath;
  const stagedPaths = stagedChanges.map((change: any) => {
    const fullPath: string = change.uri.fsPath;
    return fullPath.startsWith(workspaceRoot) ? fullPath.slice(workspaceRoot.length).replace(/^[\\/]/, "") : fullPath;
  });

  logger.log(`▶ generateCommitMessage — ${stagedChanges.length} staged file(s): ${stagedPaths.join(", ")}`);

  // Collect all staged diffs
  const diffParts: string[] = [];
  for (let i = 0; i < stagedChanges.length; i++) {
    logger.log(`── [${i + 1}/${stagedChanges.length}] ${stagedPaths[i]}`);
    try {
      const diff: string = await repo.diffIndexWithHEAD(stagedChanges[i].uri.fsPath);
      if (diff.length > 0) {
        diffParts.push(diff);
      } else {
        logger.log(`   (empty diff — skipped)`);
      }
    } catch (e) {
      logger.log(`   ⚠️  Failed to get diff: ${e}`);
    }
  }

  if (diffParts.length === 0) {
    vscode.window.showInformationMessage("Vertex AI Models Chat Provider: All staged diffs are empty.");
    return;
  }

  const combinedDiff = diffParts.join("\n");
  logger.log(`── Sending ${combinedDiff.length} chars of diff to configured model '${modelId}'…`);

  const customPrompt = config.get<string>("commitMessagePrompt")?.trim();
  const systemPrompt = customPrompt || DEFAULT_SYSTEM_PROMPT;

  // Build the VS Code LLM message objects.
  // Role 0 is neither User (1) nor Assistant (2), so VertexAnthropicProvider treats it as a system prompt.
  const systemMessage = new vscode.LanguageModelChatMessage(0 as vscode.LanguageModelChatMessageRole, systemPrompt);

  const userMessage = vscode.LanguageModelChatMessage.User(getUserPrompt(combinedDiff));

  const messages: vscode.LanguageModelChatRequestMessage[] = [systemMessage, userMessage];
  const options: vscode.ProvideLanguageModelChatResponseOptions = {
    tools: [],
    toolMode: vscode.LanguageModelChatToolMode.Auto,
  };
  const cancellation = new vscode.CancellationTokenSource();
  const token = cancellation.token;

  repo.inputBox.value = "⏳ Generating commit message…";

  // Accumulate streamed text parts
  let commitMessage = "";
  const progress: vscode.Progress<vscode.LanguageModelResponsePart> = {
    report(part) {
      if (part instanceof vscode.LanguageModelTextPart) {
        commitMessage += part.value;
      }
    },
  };

  try {
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Generating commit message", cancellable: true }, async (_progress, progressToken) => {
      const subscription = progressToken.onCancellationRequested(() => cancellation.cancel());
      try {
        if (progressToken.isCancellationRequested) { cancellation.cancel(); }
        await provider.infer(modelId, messages, options, progress, token, repo.rootUri);
      } finally { subscription.dispose(); }
    });
    commitMessage = commitMessage.trim();
    logger.log(`✅ Generated: ${commitMessage}`);
    repo.inputBox.value = commitMessage;

  } catch (e) {
    logger.log(`❌ LLM call failed: ${e}`);
    repo.inputBox.value = "";
    if (!(e instanceof vscode.CancellationError)) {
      vscode.window.showErrorMessage(`Vertex AI Models Chat Provider: Failed to generate commit message — ${e}`);
    }
  } finally {
    cancellation.dispose();
  }
}
