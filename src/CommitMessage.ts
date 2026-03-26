import * as vscode from "vscode";
import { VertexGoogleProvider } from "./providers/VertexGoogleProvider";
import { UsageTrackerService } from "./UsageTrackerService";

const MODEL_ID = "gemini-3-flash-preview";

const SYSTEM_PROMPT = `You are an expert Principal Software Engineer and a strict adherent to clean Git history. Your task is to analyze \`git diff\` outputs and generate professional, highly accurate commit messages following the Conventional Commits specification.

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

const outputChannel = vscode.window.createOutputChannel("Vertex Commit Message");

function log(msg: string): void {
  const ts = new Date().toISOString();
  outputChannel.appendLine(`[${ts}] ${msg}`);
}

function getGitAPI(): any {
  const gitExtension = vscode.extensions.getExtension<any>("vscode.git")?.exports;
  return gitExtension?.getAPI(1) ?? null;
}

function resolveRepository(git: any, resourceUri?: vscode.Uri): any {
  if (resourceUri) {
    return git.getRepository(resourceUri) ?? git.repositories?.[0] ?? null;
  }
  return git.repositories?.[0] ?? null;
}

/**
 * Command handler for "vertexAnthropic.generateCommitMessage".
 *
 * Collects staged diffs, sends them to the LLM, and writes the generated
 * commit message into the SCM input box.
 */
export async function generateCommitMessage(provider: VertexGoogleProvider, usageTracker: UsageTrackerService, resourceUri?: vscode.Uri): Promise<void> {
  const git = getGitAPI();
  if (!git) {
    vscode.window.showWarningMessage("Vertex Anthropic: Git extension is not available.");
    return;
  }

  const repo = resolveRepository(git, resourceUri);
  if (!repo) {
    vscode.window.showWarningMessage("Vertex Anthropic: No Git repository found.");
    return;
  }

  const stagedChanges: any[] = repo.state.indexChanges;
  if (stagedChanges.length === 0) {
    vscode.window.showInformationMessage("Vertex Anthropic: No staged changes found. Please stage files before generating a commit message.");
    return;
  }

  const workspaceRoot: string = repo.rootUri.fsPath;
  const stagedPaths = stagedChanges.map((change: any) => {
    const fullPath: string = change.uri.fsPath;
    return fullPath.startsWith(workspaceRoot) ? fullPath.slice(workspaceRoot.length).replace(/^[\\/]/, "") : fullPath;
  });

  outputChannel.show(true);
  log(`▶ generateCommitMessage — ${stagedChanges.length} staged file(s): ${stagedPaths.join(", ")}`);

  // Collect all staged diffs
  const diffParts: string[] = [];
  for (let i = 0; i < stagedChanges.length; i++) {
    log(`── [${i + 1}/${stagedChanges.length}] ${stagedPaths[i]}`);
    try {
      const diff: string = await repo.diffIndexWithHEAD(stagedChanges[i].uri.fsPath);
      if (diff.length > 0) {
        diffParts.push(diff);
      } else {
        log(`   (empty diff — skipped)`);
      }
    } catch (e) {
      log(`   ⚠️  Failed to get diff: ${e}`);
    }
  }

  if (diffParts.length === 0) {
    vscode.window.showInformationMessage("Vertex Anthropic: All staged diffs are empty.");
    return;
  }

  const combinedDiff = diffParts.join("\n");
  log(`── Sending ${combinedDiff.length} chars of diff to ${MODEL_ID}…`);

  // Build the VS Code LLM message objects.
  // Role 0 is neither User (1) nor Assistant (2), so VertexAnthropicProvider treats it as a system prompt.
  const systemMessage = new vscode.LanguageModelChatMessage(0 as vscode.LanguageModelChatMessageRole, SYSTEM_PROMPT);

  const userMessage = vscode.LanguageModelChatMessage.User(getUserPrompt(combinedDiff));

  const messages: vscode.LanguageModelChatRequestMessage[] = [systemMessage, userMessage];
  const options: vscode.ProvideLanguageModelChatResponseOptions = {
    tools: [],
    toolMode: vscode.LanguageModelChatToolMode.Auto,
  };
  const token = new vscode.CancellationTokenSource().token;

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
    const result = await provider.provideLanguageModelChatResponse(MODEL_ID, messages, options, progress, token);
    commitMessage = commitMessage.trim();
    log(`✅ Generated: ${commitMessage}`);
    repo.inputBox.value = commitMessage;

    if (result.usage.input > 0 || result.usage.output > 0) {
      usageTracker
        .recordUsage(MODEL_ID, {
          input: result.usage.input,
          output: result.usage.output,
          cache_read: result.usage.cache_read,
          cache_create: result.usage.cache_create,
          characters: result.charCount,
        })
        .catch((err) => log(`⚠️ Failed to record usage: ${err}`));
    }
  } catch (e) {
    log(`❌ LLM call failed: ${e}`);
    repo.inputBox.value = "";
    vscode.window.showErrorMessage(`Vertex Anthropic: Failed to generate commit message — ${e}`);
  }
}
