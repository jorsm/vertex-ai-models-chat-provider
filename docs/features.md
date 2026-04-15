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
- **Git Integration**: Uses the `vscode.git` extension to identify staged changes and retrieve diff data.
- **Contextual Analysis**: Sends the diff to the `gemini-3-flash-preview` model, emphasizing the "why" and "what" of the changes rather than just listing line modifications.
- **Streaming UI**: The generated message is streamed directly into the SCM input box, providing immediate feedback to the developer.
- **Token Efficiency**: Aggregates all staged diffs into a single request to minimize model overhead.

## API Reference

### generateCommitMessage
[source](../src/CommitMessage.ts)
This function acts as the command handler for `vertexAiChat.generateCommitMessage`. It facilitates the end-to-end workflow of converting staged code changes into a structured commit message.

**Workflow:**
1. **Repository Resolution**: Detects the relevant Git repository based on the provided `resourceUri` or active workspace.
2. **Diff Extraction**: Collects and joins all non-empty staged diffs.
3. **Prompt Engineering**: Wraps the diff in a system prompt that enforces strict rules: imperative present tense, 72-character limits for subjects, and specific commit types (feat, fix, refactor, etc.).
4. **LLM Invocation**: Calls the `VertexGoogleProvider` to generate the message.
5. **SCM Update**: Populates the Git input box with the result.
6. **Usage Recording**: Tracks token usage (input, output, cache) and character counts for the dashboard.

**Parameters:**
- `provider`: `VertexGoogleProvider` — The provider instance used to communicate with Vertex AI.
- `usageTracker`: `UsageTrackerService` — Service used to record consumption metrics for the cost dashboard.
- `resourceUri`: `vscode.Uri` (optional) — An optional URI identifying the repository context.

## Examples

### Conventional Commit Output
The generator produces raw text designed to be used immediately in a Git commit:

```text
feat(auth): add JWT validation to middleware

The previous implementation relied on session cookies. This introduces 
stateless JWT verification to support horizontal scaling.
```

### Git SCM Integration
The function is typically triggered via the magic wand icon in the SCM view title bar or via the Command Palette. It automatically handles the "⏳ Generating..." state within the input box until the stream is complete.