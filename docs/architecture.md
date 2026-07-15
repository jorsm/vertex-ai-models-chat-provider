# docs/architecture.md

> **Overview**
> This document describes the architecture and API surface of the Vertex AI Models Chat Provider. The extension acts as a dispatcher between VS Code's Language Model API and various Google Cloud Vertex AI backends (Gemini, Anthropic Claude, and MaaS open-weight models).

## Table of Contents
- [docs/architecture.md](#docsarchitecturemd)
  - [Table of Contents](#table-of-contents)
  - [Core Concepts](#core-concepts)
  - [API Reference](#api-reference)
    - [VertexChatModelDispatcher](#vertexchatmodeldispatcher)
    - [ModelSpec](#modelspec)
    - [ModelCatalog](#modelcatalog)
    - [DiscoveryResult](#discoveryresult)
    - [ModelCatalogResolver](#modelcatalogresolver)
    - [activate](#activate)
    - [runDiscovery](#rundiscovery)
  - [Examples](#examples)

---

## Core Concepts
The extension follows a provider-based architecture centered around the `VertexChatModelDispatcher`. 

- **Multi-Vendor Support**: It manages a registry of specific vendor providers (e.g., `VertexAnthropicProvider`, `VertexGoogleProvider`, `VertexMaaSProvider`) that handle the nuances of different LLM protocols while exposing a unified interface to VS Code.
- **Dynamic Discovery**: Instead of hardcoding endpoints, the extension performs region probing. It iterates through prioritized GCP regions (global, us-east5, etc.) to identify where specific models are enabled for the user's project.
- **Unified Usage Tracking**: All interactions are intercepted to record token consumption (including Gemini high-thinking blocks and Anthropic prompt caching) into a local `UsageTrackerService`.
- **VS Code Integration**: It implements the `vscode.LanguageModelChatProvider` interface, making Vertex AI models appear as native options in the Copilot Chat model picker.
- **Extension Host Flexibility**: `extensionKind` prefers the local/UI host but permits the workspace host. URI-based workspace access keeps model catalogs functional in Remote SSH, Dev Containers, and Codespaces, while a locally installed extension can use client-side ADC.

## API Reference

### VertexChatModelDispatcher
[source](../src/VertexChatModelDispatcher.ts)
The central class that implements `vscode.LanguageModelChatProvider`. It manages model discovery, provider registration, authentication via `AuthManager`, and request dispatching.

**Methods:**
- `onDidChangeLanguageModelChatInformation`: Event that fires when the available model list changes, prompting VS Code to refresh model information.
- `updateLabels()`: Triggers an asynchronous update of metadata labels by fetching and caching the current authenticated identity from `AuthManager` and propagating it to all active providers. This supports cost tracking and attribution features. All label values are sanitized to meet GCP requirements (lowercase alphanumeric, hyphens, and underscores; maximum 63 characters; ensuring they start with a letter by prepending `v_` if necessary).
- `discoverModelsAndRegion()`: Probes GCP regions to find available models based on the local catalog. It uses the `vertexAiChat.projectId` setting as the absolute source of truth for discovery and billing, intentionally avoiding fallbacks to project IDs found within Service Account credentials to ensure strict cost attribution. It includes validation logic to warn users when a Service Account belongs to a different project than the one configured, supporting cross-project IAM scenarios. It prevents concurrent discovery attempts by tracking and returning an active discovery promise if one is already in progress. Returns a `DiscoveryResult` and fires the change event upon successful discovery or failure.
- `setProjectId(projectId: string)`: Updates the active GCP project and resets discovery state.
- `clearModels()`: Clears all available models and notifies VS Code of the change. Useful when authentication fails to prevent stale models from being used.
- `provideLanguageModelChatInformation(...)`: Returns the list of discovered models to VS Code. It returns the set of models found during the discovery process, falling back to the full set of candidate models from the local catalog if discovery is not yet complete. It enriches model metadata with regional details and pricing summaries (input/output per 1M tokens) in the `detail` and `tooltip` fields. For VS Code 1.120 and higher, it explicitly sets the `vendor` to `google-vertex` and `isUserSelectable` to `true` to ensure models are correctly categorized and visible in the Copilot Chat picker.
- `provideTokenCount(...)`: Calculates or estimates token counts for messages. It delegates to provider-specific counting logic if available (e.g., for Gemini or Claude specific counting), falling back to a heuristic of ~4 characters per token if no provider logic is found (supporting both raw strings and `LanguageModelChatRequestMessage` with `LanguageModelTextPart` content).
- `provideLanguageModelChatResponse(...)`: Streams the chat response from the appropriate vendor provider. It automatically waits for any in-progress model discovery or label resolution to complete (synchronizing on internal promises) before starting inference. It resolves and injects request-level labels for cost attribution if enabled in settings. For the `vscode-vertex-ai-user` label, it prioritizes the `userLabelValue` setting, falling back to the cached identity resolved by `AuthManager`. For the `vscode-vertex-ai-project` label, it uses the `projectLabelValue` setting (specifically inspecting workspace or workspace folder level values) or falls back to a resolution chain: the workspace name, the active editor's workspace folder name, or the first workspace folder name. It records detailed usage (input, output, cache_read, cache_create, and total character counts) via the `UsageTrackerService`.
- `getAnthropicProvider()`: Returns the registered `VertexAnthropicProvider` instance.
- `getGoogleProvider()`: Returns the registered `VertexGoogleProvider` instance.

### ModelSpec
[source](../src/VertexChatModelDispatcher.ts)
Interface defining the metadata and capabilities for a supported model.

**Properties:**
- `id`: Unique identifier for the model.
- `vendor`: The vendor name (e.g., "google", "anthropic", "maas").
- `displayName`: Human-readable name shown in the UI.
- `family`: Model family (e.g., "gemini", "claude").
- `version`: The specific API version/model name.
- `maxInputTokens`: Maximum allowed input tokens.
- `maxOutputTokens`: Maximum allowed output tokens.
- `temperature` (optional): Sampling temperature to use for the model.
- `top_p` (optional): Top-p (nucleus) sampling parameter.
- `capabilities`: Object containing `imageInput` and `toolCalling` booleans.
- `pricing`: Object defining token costs:
    - `input`: Cost per 1 million input tokens.
    - `output`: Cost per 1 million output tokens.
    - `cache_read` (optional): Cost per 1 million cached tokens read.
    - `cache_create` (optional): Cost per 1 million cached tokens written.

### ModelCatalog
[source](../src/VertexChatModelDispatcher.ts)
Interface for the `models.json` structure containing the list of potential models and region priorities.

**Properties:**
- `candidateModels`: Array of `ModelSpec` objects representing supported model versions.
- `regionPriority`: Ordered list of strings representing GCP regions to probe (e.g., `global`, `us-east5`).

### DiscoveryResult
[source](../src/VertexChatModelDispatcher.ts)
The result of a region discovery operation, containing the successful `region` and the list of `availableModels`.

**Properties:**
- `region`: The successfully identified GCP region where models responded.
- `availableModels`: Array of `ModelSpec` objects successfully pinged in the identified region.

### ModelCatalogResolver
[source](../src/ModelCatalogResolver.ts)
Resolves the effective model catalog at runtime, enabling user- and workspace-level overrides of the bundled `models.json`. Resolution precedence is **Workspace (`.vscode/models.json`) > User (extension `globalStorageUri/models.json`) > Bundled (`src/models.json`)**. A custom file fully *replaces* the bundled catalog (it is not merged); the bundled catalog is used only as the seed template when a custom file is first created, and as the final fallback when no custom file exists or one fails to parse.

**Methods:**
- `getEffectiveCatalog()`: Returns the effective `ModelCatalog` following the precedence above. Results are cached until `invalidateCache()` is called. On a parse error in a custom file, logs the error, shows a one-shot error message, and falls back to the next tier (never throws — callers always get a usable catalog).
- `getWorkspaceCatalogUri()`: Returns the URI of the workspace-level catalog for the first workspace folder, or `undefined` when no workspace folder is open. Does not create the file.
- `getUserCatalogUri()`: Returns the URI of the user-level catalog in the extension's global storage. Does not create the file.
- `ensureUserCatalogExists()`: Ensures the user-level catalog exists, seeding it from the bundled catalog if absent. Returns the URI.
- `ensureWorkspaceCatalogExists()`: Ensures the workspace-level catalog exists for the first workspace folder, seeding it from the bundled catalog if absent. Returns `undefined` if no workspace folder is open.
- `invalidateCache()`: Clears the cached effective catalog so the next `getEffectiveCatalog()` re-reads from disk.

The extension registers two palette commands backed by this resolver: `vertexAiChat.openUserModelsFile` and `vertexAiChat.openWorkspaceModelsFile`. Both custom file paths are covered by `contributes.jsonValidation` globs in `package.json`, providing JSON schema validation and autocomplete in the editor. A `FileSystemWatcher` on both files invalidates the cache and re-runs discovery on save (debounced ~300ms), refreshing the Copilot Chat model picker.

### activate
[source](../src/extension.ts)
The main entry point for the VS Code extension. It handles:
- Initializing the global `Logger` for structured logging and diagnostics.
- Configuration migration from legacy settings (`vertexAnthropic` to `vertexAiChat`), including Project ID and billing warning preferences.
- Initializing the `AuthManager`, `UsageTrackerService`, `CostStatusBar`, and `ModelCatalogResolver`.
- Registering the `VertexChatModelDispatcher` as a language model chat provider for the `google-vertex` vendor.
- Registering extension commands including:
    - `claudeBilling.showDashboard`: Opens the usage dashboard webview.
    - `vertexAiChat.refreshModels`: Manually triggers the model discovery process.
    - `vertexAiChat.dumpTools`: Dumps the schema of all installed language model tools to an output channel for debugging.
    - `vertexAiChat.generateCommitMessage`: Generates AI-powered commit messages from staged changes when the built-in Git API is available in the same extension host.
    - `vertexAiChat.setServiceAccountKey`: Securely saves a Service Account JSON key to OS storage.
    - `vertexAiChat.setServiceAccountPath`: Imports a selected Service Account JSON file into `SecretStorage`. The command identifier is retained for compatibility, but no new file path is stored.
    - `vertexAiChat.removeServiceAccount`: Deletes a named Service Account from `SecretStorage`; removing the active credential resets the workspace to ADC.
    - `vertexAiChat.selectAuthMethod`: Switches the active authentication method.
    - `vertexAiChat.clearAuthMethod`: Resets the workspace to use Default Application Credentials (ADC).
    - `vertexAiChat.openUserModelsFile`: Creates (seeded from the bundled catalog) / opens the user-level `models.json` for editing.
    - `vertexAiChat.openWorkspaceModelsFile`: Creates (seeded from the bundled catalog) / opens `.vscode/models.json` for editing.
- Watching for configuration changes (specifically `vertexAiChat.projectId`, `enableUserLabel`, and `enableProjectLabel`) to trigger re-discovery and update metadata labels.
- Watching the workspace and user custom `models.json` files via `FileSystemWatcher` to invalidate the catalog cache and re-run discovery on save (debounced ~300ms).

### runDiscovery
[source](../src/extension.ts)
A helper function that triggers the model discovery process on the dispatcher and provides UI feedback (Information, Warning, or Error messages) to the user based on the results.

In the event of a failure (networking, project errors, or authentication), it clears any stale model list to prevent "silent fallbacks" in the chat UI. If a `VertexAuthenticationError` occurs, it provides a specialized workflow that:

- Prompts the user to log in through the Google Cloud SDK (`gcloud`) with a label that identifies local authentication in remote windows.
- When the extension runs in the local/UI host against a remote workspace, spawns the local `gcloud auth application-default login` process directly and reports missing CLI, cancellation, or non-zero exit errors.
- In a normal local window or when installed in the workspace host, opens an integrated terminal and uses VS Code shell execution completion when available.
- Switches the active method to ADC and re-runs discovery after a confirmed successful login.

---

## Examples
*(High-level explanation of the architecture, dependencies, or primary design patterns used in this code).*
