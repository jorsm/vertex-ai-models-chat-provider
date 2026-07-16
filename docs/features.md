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
- **Contextual Analysis**: Sends the diff to the `gemini-3-flash-preview` model, emphasizing the "why" and "what" of the changes rather than just listing line modifications.
- **Strict Formatting**: The system prompt enforces specific constraints: imperative present tense, no trailing periods, and a 72-character limit for subject lines.
- **Streaming UI**: The generated message is streamed directly into the SCM input box, providing immediate feedback to the developer.
- **Token Efficiency**: Aggregates all staged diffs into a single request to minimize model overhead and provides detailed logging of processed file paths.

## API Reference

### generateCommitMessage
[source](../src/CommitMessage.ts)
This function acts as the command handler for `vertexAiChat.generateCommitMessage`. It facilitates the end-to-end workflow of converting staged code changes into a structured commit message.

**Workflow:**
1. **Repository Resolution**: Detects the relevant Git repository based on the provided `resourceUri` or active workspace.
2. **Diff Extraction**: Collects and joins all non-empty staged diffs, logging relative file paths to the **Vertex AI Models: Commit Message** output channel.
3. **Prompt Engineering**: Wraps the diff in a system prompt that enforces strict rules: imperative present tense, 72-character limits for subjects, and specific commit types (`feat`, `fix`, `refactor`, `perf`, `style`, `test`, `docs`, `chore`, `build`, `ci`).
4. **LLM Invocation**: Calls the `VertexGoogleProvider` using a `gemini-3-flash-preview` model. It utilizes a custom system message role (role 0) to pass instructions to the provider.
5. **SCM Update**: Initially sets the Git input box to "⏳ Generating commit message…" and then populates it with the streamed result, trimmed of whitespace.
6. **Usage Recording**: Tracks token usage (input, output, cache_read, cache_create) and character counts for the local usage dashboard via the `UsageTrackerService`.

**Parameters:**
- `provider`: `VertexGoogleProvider` — The provider instance used to communicate with Vertex AI.
- `usageTracker`: `UsageTrackerService` — Service used to record consumption metrics for the cost dashboard.
- `resourceUri`: `vscode.Uri` (optional) — An optional URI identifying the repository context.

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
