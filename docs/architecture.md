# docs/architecture.md

> **Overview**
> This document describes the architecture and API surface of Google Agent Platform for Copilot Chat. The extension acts as a dispatcher between VS Code's Language Model API and the Google Gemini, Anthropic Claude, and xAI Grok backends on Vertex AI.

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

- **Multi-Vendor Support**: It manages a registry of specific vendor providers (`VertexAnthropicProvider`, `VertexGoogleProvider`, and `VertexGrokProvider`) that handle the nuances of different LLM protocols while exposing a unified interface to VS Code.
- **Dynamic Discovery**: Instead of hardcoding endpoints, the extension performs region probing. It iterates through prioritized GCP regions (global, us-east5, etc.) to identify where specific models are enabled for the user's project.
- **Experimental Enterprise Proxy**: Supports an optional Python Cloud Function v2 gateway via `vertexAiChat.proxyUrl`. In proxy mode, discovery and streaming are server-controlled using the user's personal identity; direct Vertex fallback is disabled, and Grok is unavailable.
- **Unified Usage Tracking**: All interactions are intercepted to record token consumption (including Gemini high-thinking blocks and Anthropic prompt caching) into a local `UsageTrackerService`.
- **VS Code Integration**: It implements the `vscode.LanguageModelChatProvider` interface, making Vertex AI models appear as native options in the Copilot Chat model picker.
- **Workspace-Host Execution**: `extensionKind` requires the workspace host so Copilot Chat and the language-model provider share an extension host. In remote environments, ADC and Service Account credentials are resolved by the remotely installed extension.

## API Reference

### VertexChatModelDispatcher
[source](../src/VertexChatModelDispatcher.ts)
The central class that implements `vscode.LanguageModelChatProvider`. It manages model discovery, provider registration, authentication via `AuthManager`, and request dispatching. It registers vendor-specific providers, including configuring the `VertexGrokProvider` with the catalog resolver to ensure correct vendor-specific model identification.

**Methods:**
- `getConnectionRevision()`: [source](../src/VertexChatModelDispatcher.ts) Returns the current connection revision number, used to detect configuration changes during asynchronous discovery.
- `dispose()`: [source](../src/VertexChatModelDispatcher.ts) Disposes of the proxy gateway and internal event emitters.
- `onDidChangeLanguageModelChatInformation`: Event that fires when the available model list changes, prompting VS Code to refresh model information.
- `updateLabels()`: [source](../src/VertexChatModelDispatcher.ts) When the user label is enabled, fetches and caches the current client Google identity from `AuthManager` in both direct and proxy modes and propagates it as a provider baseline. The `gcloud config get-value account` fallback accepts only the first output line and only when it is an email address, so CLI notices cannot become a label. Actual labels are resolved per request, preferring an explicit `userLabelValue` over the cached identity. Values are sanitized to GCP label requirements (lowercase alphanumeric, hyphens, and underscores; maximum 63 characters; a leading letter is enforced with `v_`).
- `getProxyUrl()`: [source](../src/VertexChatModelDispatcher.ts) Retrieves the experimental proxy URL from machine-scoped settings.
- `resetConnection()`: [source](../src/VertexChatModelDispatcher.ts) Increments the connection revision, disposes of the current gateway, clears cached proxy tokens and models, and resets discovery state.
- `discoverModelsAndRegion()`: [source](../src/VertexChatModelDispatcher.ts) Probes GCP regions or the configured proxy gateway to find available models. In direct mode, it groups entries by vendor/backend model and probes at most three endpoints concurrently within each region. Providers resolve catalog effort aliases through `getDiscoveryModelId()`, and all entries for a reachable endpoint remain available in their original catalog order. In proxy mode, it uses a `ProxyGateway` for authenticated discovery of the complete server catalog, including variants, capabilities and pricing; it performs no inference probes. The configurable `vertexAiChat.modelDiscoveryTimeoutSeconds` defaults to 45 seconds per endpoint after it leaves the queue. It uses the `vertexAiChat.projectId` setting as the absolute source of truth for discovery and billing in direct mode, intentionally avoiding fallbacks to project IDs found within Service Account credentials. It prevents concurrent discovery attempts by tracking and returning an active discovery promise if one is already in progress. It bubbles `VertexAuthenticationError` up to trigger specialized authentication workflows. Returns a `DiscoveryResult` and fires the change event upon successful discovery or failure.
- `setProjectId(projectId: string)`: [source](../src/VertexChatModelDispatcher.ts) Updates the active GCP project and resets discovery state.
- `clearModels()`: [source](../src/VertexChatModelDispatcher.ts) Clears all available models and notifies VS Code of the change. Useful when authentication fails to prevent stale models from being used.
- `provideLanguageModelChatInformation(...)`: [source](../src/VertexChatModelDispatcher.ts) Returns the list of discovered models to VS Code. It returns the set of models found during the discovery process, falling back to local candidate models before discovery only in direct mode. Proxy mode publishes only the complete server catalog. It enriches model metadata with regional details and pricing summaries. For VS Code 1.120 and higher, it explicitly sets the `vendor` to `google-vertex` and `isUserSelectable` to `true` to ensure models are correctly categorized and visible in the Copilot Chat picker.
- `provideTokenCount(...)`: [source](../src/VertexChatModelDispatcher.ts) Calculates or estimates token counts for messages. It delegates to provider-specific counting logic if available, falling back to a heuristic of ~4 characters per token if no provider logic is found.
- `provideLanguageModelChatResponse(...)`: [source](../src/VertexChatModelDispatcher.ts) Streams the chat response from the appropriate vendor provider. It automatically waits for any in-progress model discovery or label resolution to complete before starting inference.
- `inferCommit(...)`: [source](../src/VertexChatModelDispatcher.ts) Special inference path for AI commit message generation. It ensures discovery is complete and attempts to use a Gemini Flash model for the request.
- `infer(...)`: [source](../src/VertexChatModelDispatcher.ts) Internal method that executes the inference request. It resolves and injects request-level labels for cost attribution if enabled. In both direct and proxy modes, `vscode-vertex-ai-user` checks `vertexAiChat.userLabelValue` before falling back to the cached client Google identity. The proxy independently adds its non-forgeable OIDC-derived identity label. For `vscode-vertex-ai-project`, the extension checks `vertexAiChat.projectLabelValue` (specifically workspace/folder overrides), then falls back to the workspace name, the active editor's workspace folder name, or finally the first workspace folder name. Proxy mode restricts vendors to Google and Anthropic. It warns via VS Code notification if a label is enabled but cannot be resolved. It records detailed usage (input, output, cache_read, cache_create, and total character counts) via the `UsageTrackerService`.
- `getAnthropicProvider()`: [source](../src/VertexChatModelDispatcher.ts) Returns the registered `VertexAnthropicProvider` instance.
- `getGoogleProvider()`: [source](../src/VertexChatModelDispatcher.ts) Returns the registered `VertexGoogleProvider` instance.

### ModelSpec
[source](../src/providers/VertexModelProvider.ts)
Interface defining the metadata and capabilities for a supported model.

**Properties:**
- `id`: Unique identifier for the model.
- `vendor`: The provider route: `"google"`, `"anthropic"`, or `"grok"`.
- `displayName`: Human-readable name shown in the UI.
- `family`: Model family (e.g., "gemini", "claude").
- `version`: The specific API version/model name.
- `maxInputTokens`: Maximum allowed input tokens.
- `maxOutputTokens`: Maximum allowed output tokens.
- `capabilities`: Object containing `imageInput` and `toolCalling` booleans.
- `pricing`: Object defining token costs:
    - `input`: Cost per 1 million input tokens.
    - `output`: Cost per 1 million output tokens.
    - `cache_read` (optional): Cost per 1 million cached tokens read.
    - `cache_create` (optional): Cost per 1 million cached tokens written.
    - `longContext` (optional): Replacement rate card for requests whose total uncached and cached input exceeds `inputThresholdTokens`. The whole request is costed with these rates.

### ModelCatalog
[source](../src/providers/VertexModelProvider.ts)
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
    - `vertexAiChat.setServiceAccountPath`: Imports a selected Service Account JSON file into `SecretStorage`. The command identifier is retained for compatibility; no new path is stored and the source file is unchanged.
    - `vertexAiChat.removeServiceAccount`: Deletes only the extension's stored copy of a named Service Account; removing the active credential resets the workspace to ADC without changing Google Cloud resources.
    - `vertexAiChat.selectAuthMethod`: Switches the active authentication method via a QuickPick menu.
    - `vertexAiChat.clearAuthMethod`: Resets the workspace to use Default Application Credentials (ADC).
    - `vertexAiChat.openUserModelsFile`: Creates (seeded from the bundled catalog) / opens the user-level `models.json` for editing.
    - `vertexAiChat.openWorkspaceModelsFile`: Creates (seeded from the bundled catalog) / opens `.vscode/models.json` for editing.
- Watching for configuration changes (specifically `vertexAiChat.projectId`, `vertexAiChat.proxyUrl`, `enableUserLabel`, and `enableProjectLabel`) to trigger re-discovery and update metadata labels.
- Watching the workspace and user custom `models.json` files via `FileSystemWatcher` to invalidate the catalog cache and re-run discovery on save (debounced ~300ms).

### runDiscovery
[source](../src/extension.ts)
A helper function that triggers the model discovery process on the dispatcher and provides UI feedback (Information, Warning, or Error messages) to the user based on the results.

In the event of a failure (networking, project errors, or authentication), it clears any stale model list to prevent silent model fallbacks in the chat UI. Authentication failures use three explicit workflows:

- A `GatewayError` displays a specific error message for proxy configuration issues.
- A `VertexAuthenticationError` offers `gcloud auth application-default login` in the workspace environment, switches the active method to ADC, and re-runs discovery after confirmed success.
- An `AuthConfigurationError` from a missing or invalid explicitly selected Service Account fails closed and offers the authentication-method picker. It never substitutes an ambient ADC identity.

---

## Examples
*(High-level explanation of the architecture, dependencies, or primary design patterns used in this code).*
