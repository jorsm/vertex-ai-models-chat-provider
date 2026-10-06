# docs/features.md

> **Overview**
> This module implements the logic for the automatic generation of detailed commit messages.

## Table of Contents
- [docs/features.md](#docsfeaturesmd)
  - [Table of Contents](#table-of-contents)
  - [Core Concepts](#core-concepts)
    - [Commit Message Generation](#commit-message-generation)
  - [API Reference](#api-reference)
    - [generateCommitMessage](#generatecommitmessage)
  - [Examples](#examples)
    - [Conventional Commit Output](#conventional-commit-output)
    - [Git SCM Integration](#git-scm-integration)

---

## Core Concepts

### Commit Message Generation
The extension provides an AI-powered commit message generator that integrates directly with the VS Code Source Control Management (SCM) view. It analyzes staged `git diff` outputs and produces professional messages following the [Conventional Commits](https://www.conventionalcommits.org/) specification. 

Key aspects of the generation logic include:
- **Optional Git Integration**: Activates and uses the `vscode.git` extension, when its API is available in the same extension host, to identify staged changes and retrieve diff data using `diffIndexWithHEAD`.
- **Contextual Analysis**: Sends the diff to an authorized model via the dispatcher, emphasizing the "why" and "what" of the changes rather than just listing line modifications. In [proxy mode](proxy.md), commit generation uses the same gateway, server catalog, policies, repository attribution, and usage accounting as chat.
- **Strict Formatting**: The default system prompt enforces specific constraints: imperative present tense, no trailing periods, and a 72-character limit for subject lines.
- **Customizable Prompt**: Users can override the system prompt via the resource-scoped `vertexAiChat.commitMessagePrompt` setting (e.g. to enforce single-line titles or custom team formatting standards). In a multi-root workspace, the Source Control action uses the setting for the selected repository.
- **Configurable Model**: `vertexAiChat.commitMessageModel` defaults to Gemini 3 Flash (`gemini-3-flash-preview`) and accepts an exact model ID in user, workspace, or folder settings. Folder settings override workspace settings, which override user settings. **Google Agent Platform: Select Commit Message Model** refreshes shared discovery and opens a `vscode.window.showQuickPick` of the available models, with the configured model listed first. It updates the existing effective setting's scope; a new choice is saved for the repository folder, or at workspace/user level when no matching folder is open. The shared inference layer validates the configured ID against the current discovered catalog when generating. An empty or unavailable selection, including an unavailable default, produces an error notification; no other model is selected and the saved setting is preserved. Model selection and prompts are independent of VS Code's `chat.utilitySmallModel` setting.
- **Streaming UI**: The generated message is streamed directly into the SCM input box, providing immediate feedback to the developer.
- **Token Efficiency**: Aggregates all staged diffs into a single request to minimize model overhead and provides detailed logging of processed file paths.

## API Reference

### generateCommitMessage
[source](../src/commitMessage/CommitMessage.ts)
This function acts as the command handler for `vertexAiChat.generateCommitMessage`. It facilitates the end-to-end workflow of converting staged code changes into a structured commit message.

**Workflow:**
1. **Repository Resolution**: Detects the relevant Git repository from the URI or Source Control context provided by VS Code, falling back to the active workspace.
2. **Diff Extraction**: Collects and joins all non-empty staged diffs, logging relative file paths to the **Google Agent Platform for Copilot Chat** output channel.
3. **Prompt Engineering**: Wraps the diff in either the configured `vertexAiChat.commitMessagePrompt` or the default system prompt that enforces strict rules: imperative present tense, 72-character limits for subjects, and specific commit types (`feat`, `fix`, `refactor`, `perf`, `style`, `test`, `docs`, `chore`, `build`, `ci`).
4. **LLM Invocation**: Calls the dispatcher's shared `infer()` method with the configured model ID and repository URI. Catalog validation and provider routing belong to that shared layer. It utilizes a custom system message role (role 0) to pass instructions to the provider.
5. **SCM Update**: Initially sets the Git input box to "⏳ Generating commit message…" and then populates it with the streamed result, trimmed of whitespace.

**Parameters:**
- `provider`: `Pick<VertexChatModelDispatcher, "infer">` — The shared inference interface that validates and executes the exact requested model.
- `context`: `vscode.Uri | vscode.SourceControl` (optional) — The repository context supplied by a programmatic invocation or the SCM title action.

## Examples

### Conventional Commit Output
The generator produces raw text designed to be used immediately in a Git commit, following strict output constraints (no markdown blocks, no conversational filler):

```text
feat(auth): add JWT validation to middleware

The previous implementation relied on session cookies. This introduces 
stateless JWT verification to support horizontal scaling.
```

### Git SCM Integration
The function is typically triggered via the magic wand icon in the SCM view title bar or via the Command Palette. It automatically handles the "⏳ Generating..." state within the input box until the stream is complete and logs the final generated message to the internal diagnostics channel.

The Git API must be available in the same extension host. Because this extension runs with the workspace, remote Git integrations normally share its host; if the built-in Git API is unavailable, the command reports that limitation and stops without affecting the chat provider.
