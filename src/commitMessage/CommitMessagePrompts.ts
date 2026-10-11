import * as vscode from "vscode";

/**
 * Default Conventional Commits instructions for commit-message generation.
 *
 * @remarks
 * A non-empty, trimmed `vertexAiChat.commitMessagePrompt` setting replaces
 * this prompt for the selected repository.
 */
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

/**
 * System role understood by the internal provider adapters.
 *
 * @remarks
 * VS Code's public enum only exposes user and assistant roles. Messages using
 * this internal role must be passed directly to the extension's dispatcher.
 */
const SYSTEM_MESSAGE_ROLE = 0 as vscode.LanguageModelChatMessageRole;

/**
 * Builds the system and user messages for one commit-message request.
 *
 * @param diffString - Combined non-empty staged diffs from the selected repository.
 * @param systemPrompt - Effective custom prompt or {@link DEFAULT_SYSTEM_PROMPT}.
 * @returns Messages for internal inference, with the system instructions first.
 */
export function createCommitMessageMessages(diffString: string, systemPrompt: string): vscode.LanguageModelChatRequestMessage[] {
    return [
        new vscode.LanguageModelChatMessage(SYSTEM_MESSAGE_ROLE, systemPrompt),
        vscode.LanguageModelChatMessage.User(getUserPrompt(diffString)),
    ];
}

/**
 * Includes the complete diff verbatim, without truncation or token-budget checks.
 *
 * @param diffString - Combined staged diffs to include in the user message.
 * @returns Instructions requesting raw commit-message text followed by the supplied diff.
 */
function getUserPrompt(diffString: string): string {
    return `Analyze the following staged Git diff and generate a commit message based on your system instructions.

CRITICAL: Output ONLY the raw commit message text. Do NOT wrap your response in markdown formatting or code blocks. Do NOT include conversational filler.

Git Diff:
${diffString}`;
}
