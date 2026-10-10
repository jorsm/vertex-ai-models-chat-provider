# docs/architecture.md

> **Overview**
> This document describes the architecture and API surface of Google Agent Platform for Copilot Chat. The extension acts as a dispatcher between VS Code's Language Model API and the Google Gemini, Anthropic Claude, and xAI Grok backends on Vertex AI.

## Table of Contents
- [docs/architecture.md](#docsarchitecturemd)
  - [Table of Contents](#table-of-contents)
  - [Core Concepts](#core-concepts)
  - [API Reference](#api-reference)
    - [VertexChatModelDispatcher](#vertexchatmodeldispatcher)
    - [MissingProjectIdError](#missingprojectiderror)
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
- **Dynamic Discovery**: Instead of hardcoding endpoints, the extension performs region probing. It iterates through the effective catalog's `regionPriority` to identify where specific models are enabled for the user's project.
- **Enterprise Proxy**: `vertexAiChat.proxyUrl` selects an organization-managed HTTP gateway for centralized metrics, policies, and business logic. `projectId` stays mandatory and is sent to the proxy in each request path, so the flow is client → proxy → Vertex instead of client → Vertex. The server publishes the authorized model catalog, decides whether the requested project, region and model are permitted, and calls Vertex with its own credentials; callers authenticate with a personal Google ID token. Direct fallback is disabled. See the [proxy contract](proxy.md) and [compatibility checks](proxy-compatibility.md).
- **Unified Usage Tracking**: All interactions are intercepted to record token consumption (including Gemini high-thinking blocks and Anthropic prompt caching) into a local `UsageTrackerService`.
- **VS Code Integration**: It implements the `vscode.LanguageModelChatProvider` interface, making Vertex AI models appear as native options in the Copilot Chat model picker.
- **Workspace-Host Execution**: `extensionKind` requires the workspace host so Copilot Chat and the language-model provider share an extension host. In remote environments, ADC and Service Account credentials are resolved by the remotely installed extension.

## API Reference

### VertexChatModelDispatcher
[source](../src/VertexChatModelDispatcher.ts)
The central class that implements `vscode.LanguageModelChatProvider`. It manages model discovery, provider registration, authentication via `AuthManager`, and request dispatching. It registers vendor-specific providers, including configuring the `VertexGrokProvider` with the catalog resolver to ensure correct vendor-specific model identification.

**Methods:**
- `getConnectionRevision()`: [source](../src/VertexChatModelDispatcher.ts) Returns the current connection revision number, used to detect configuration changes during asynchronous discovery.
- `dispose()`: [source](../src/VertexChatModelDispatcher.ts) Disposes of the proxy gateway, internal event emitters, and authentication subscriptions.
- `onDidChangeLanguageModelChatInformation`: Event that fires when the available model list changes, prompting VS Code to refresh model information.
- `updateLabels()`: [source](../src/VertexChatModelDispatcher.ts) When the user label is enabled, fetches and caches the current client Google identity from `AuthManager` in both direct and proxy modes and propagates it as a provider baseline. Actual labels are resolved per request, preferring an explicit `userLabelValue` over the cached identity. Values are sanitized to GCP label requirements (lowercase alphanumeric, hyphens, and underscores; maximum 63 characters; a leading letter is enforced with `v_`).
- `getProxyUrl()`: [source](../src/VertexChatModelDispatcher.ts) Retrieves the enterprise proxy base URL from the user value of the machine-scoped setting; workspace endpoint overrides are ignored.
- `resetConnection()`: [source](../src/VertexChatModelDispatcher.ts) Increments the connection revision, disposes of the current gateway, clears cached proxy tokens and models, and resets discovery state.
- `discoverModelsAndRegion()`: [source](../src/VertexChatModelDispatcher.ts) Probes GCP regions or the configured proxy gateway to find available models. It requires `projectId` in every mode and throws `MissingProjectIdError` before credentials or network access when it is unset. In direct mode, it groups entries by vendor/backend model and probes at most three endpoints concurrently within each region using randomized exponential backoff for retries. Providers resolve catalog effort aliases through `getDiscoveryModelId()`, and all entries for a reachable endpoint remain available in their original catalog order. In proxy mode, it uses a `ProxyGateway` for authenticated discovery of the complete server catalog, including variants, capabilities and pricing; it performs no inference probes or vendor filtering and initializes all registered adapters with the gateway and the first region in the server's `regionPriority`. A nonempty server catalog requires a region; the client never supplies a default region. The configurable `vertexAiChat.modelDiscoveryTimeoutSeconds` defaults to 45 seconds per endpoint after it leaves the queue. It uses the `vertexAiChat.projectId` setting as the absolute source of truth for discovery and billing, in direct and proxy mode alike, intentionally avoiding fallbacks to project IDs found within Service Account credentials. It prevents concurrent discovery attempts by tracking and returning an active discovery promise if one is already in progress. It bubbles `VertexAuthenticationError` up to trigger specialized authentication workflows. Returns a `DiscoveryResult` and fires the change event upon successful discovery or failure.
- `setProjectId(projectId: string)`: [source](../src/VertexChatModelDispatcher.ts) Updates the active GCP project and resets discovery state.
- `clearModels()`: [source](../src/VertexChatModelDispatcher.ts) Clears all available models and notifies VS Code of the change. Useful when authentication fails to prevent stale models from being used.
- `provideLanguageModelChatInformation(...)`: [source](../src/VertexChatModelDispatcher.ts) Returns the list of discovered models to VS Code. It returns the set of models found during discovery, remaining empty before the first discovery completes. Proxy mode publishes the complete server catalog without filtering vendors. It enriches model metadata with regional details and pricing summaries (including long-context rates and cache costs). For VS Code 1.120 and higher, it explicitly sets the `vendor` to `google-vertex` and `isUserSelectable` to `true` to ensure models are correctly categorized and visible in the Copilot Chat picker.
- `provideTokenCount(...)`: [source](../src/VertexChatModelDispatcher.ts) Calculates or estimates token counts for messages. It delegates to provider-specific counting logic if available, falling back to a heuristic estimation if no provider logic is found.
- `provideLanguageModelChatResponse(...)`: [source](../src/VertexChatModelDispatcher.ts) Streams the chat response from the appropriate vendor provider. It automatically waits for any in-progress model discovery to complete before starting inference. It handles specialized error mapping for `GatewayError` statuses (e.g., 401/403 to `NoPermissions`, 404 to `NotFound`).
- `infer(...)`: [source](../src/VertexChatModelDispatcher.ts) Shared entry point used by chat and commit generation to execute the exact requested model ID. It ensures discovery is complete, retries one empty/error discovery state per request, and rejects IDs missing from the active discovered catalog without selecting another model. It resolves and injects request-level labels for cost attribution if enabled via a resource-aware resolver. In both direct and proxy modes, `vscode-vertex-ai-user` checks `vertexAiChat.userLabelValue` before falling back to the cached client Google identity. The proxy independently adds its non-forgeable OIDC-derived identity label. For `vscode-vertex-ai-project`, the extension checks `vertexAiChat.projectLabelValue` (specifically workspace/folder overrides), then falls back to the workspace name, the active editor's workspace folder name, or finally the first workspace folder name. The catalog selects the vendor; a missing adapter or unsupported transport produces an inference error. It warns via VS Code notification if a label is enabled but cannot be resolved. It records detailed usage (input, output, cache_read, cache_create, and total character counts) via the `UsageTrackerService`.
- `getAnthropicProvider()`: [source](../src/VertexChatModelDispatcher.ts) Returns the registered `VertexAnthropicProvider` instance.
- `getGoogleProvider()`: [source](../src/VertexChatModelDispatcher.ts) Returns the registered `VertexGoogleProvider` instance.

### MissingProjectIdError
[source](../src/VertexChatModelDispatcher.ts)
Raised before any network or credential access when `vertexAiChat.projectId` is unset.

**Properties:**
- `viaProxy`: Boolean indicating if the error occurred while a proxy was configured.

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
- `region`: The selected GCP region, from direct probing or the server catalog; `undefined` when no region is selected.
- `availableModels`: Array of `ModelSpec` objects discovered in direct mode or advertised by the proxy.

### ModelCatalogResolver
[source](../src/ModelCatalogResolver.ts)
In direct mode, resolves the effective model catalog at runtime, enabling user- and workspace-level overrides of the bundled `models.json`. Resolution precedence is **Workspace (`.vscode/models.json`) > User (extension `globalStorageUri/models.json`) > Bundled (`src/models.json`)**. A custom file fully *replaces* the bundled catalog (it is not merged); the bundled catalog is used only as the seed template when a custom file is first created, and as the final fallback when no custom file exists or one fails to parse. In proxy mode, the server catalog takes precedence over all local sources, including when empty; failed discovery cannot restore a local catalog.

**Methods:**
- `setProxyCatalog(catalog)`: Retains the complete server `ModelCatalog`, including `regionPriority`. An empty catalog stays authoritative; `undefined` restores local catalog resolution.
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
    - `claudeBilling.showDashboard`: Opens the usage dashboard webview via `DashboardWebview.createOrShow`.
    - `vertexAiChat.refreshModels`: Manually triggers the model discovery process.
    - `vertexAiChat.dumpTools`: Dumps the schema of all installed language model tools to an output channel for debugging, including tool names, descriptions, tags, and input schemas.
    - `vertexAiChat.generateCommitMessage`: Generates AI-powered commit messages from staged changes when the built-in Git API is available in the same extension host.
    - `vertexAiChat.selectCommitMessageModel`: Refreshes shared discovery and opens a model QuickPick, persisting an exact ID in `vertexAiChat.commitMessageModel`. It preserves the effective user/workspace/folder override's scope; new choices apply to the repository folder, otherwise workspace/user. The setting defaults to `gemini-3-flash-preview`; generation never substitutes another model if it is unavailable. Commit-message generation and selection live in `src/commitMessage/`, with the selection UI in `CommitMessageModelSelection.ts` separate from diff collection and inference.
    - `vertexAiChat.setServiceAccountKey`: Securely saves a Service Account JSON key to OS storage.
    - `vertexAiChat.setServiceAccountPath`: Imports a selected Service Account JSON file into `SecretStorage`. The command identifier is retained for compatibility; no new path is stored and the source file is unchanged.
    - `vertexAiChat.removeServiceAccount`: Deletes only the extension's stored copy of a named Service Account; removing the active credential resets the workspace to ADC without changing Google Cloud resources.
    - `vertexAiChat.selectAuthMethod`: Switches the active authentication method via a QuickPick menu.
    - `vertexAiChat.clearAuthMethod`: Resets the workspace to use Default Application Credentials (ADC).
    - `vertexAiChat.openUserModelsFile`: Creates (seeded from the bundled catalog) / opens the user-level `models.json` for editing.
    - `vertexAiChat.openWorkspaceModelsFile`: Creates (seeded from the bundled catalog) / opens `.vscode/models.json` for editing.
- Watching for configuration changes (specifically `vertexAiChat.projectId`, `vertexAiChat.proxyUrl`, `enableUserLabel`, and `enableProjectLabel`) to trigger re-discovery and update metadata labels.
- Watching the workspace and user custom `models.json` files via `FileSystemWatcher` to invalidate the catalog cache and re-run discovery on save (debounced ~300ms).
- Performing a background discovery run on activation if a `projectId` is already configured.

### runDiscovery
[source](../src/extension.ts)
A helper function that triggers the model discovery process on the dispatcher and provides UI feedback (Information, Warning, or Error messages) to the user based on the results. It tracks connection revisions to ensure that outdated discovery attempts do not overwrite current state if a configuration change happens mid-discovery.

In the event of a failure (networking, project errors, or authentication), it clears any stale model list to prevent silent model fallbacks in the chat UI. Authentication failures use three explicit workflows:

- A `GatewayError` displays a specific error message for proxy configuration issues.
- A `VertexAuthenticationError` offers `gcloud auth application-default login` (or the appropriate login action) in the workspace environment, and re-runs discovery after confirmed success.
- An `AuthConfigurationError` from a missing or invalid explicitly selected Service Account fails closed and offers the authentication-method picker. It never substitutes an ambient ADC identity.
- A `MissingProjectIdError` provides a direct link to the `vertexAiChat.projectId` setting via a button in the error message.

---

## Examples
*(High-level explanation of the architecture, dependencies, or primary design patterns used in this code).*
## Thinking effort resolution

The dispatcher retains canonical definitions for endpoint discovery and builds an immutable `EffortCatalog` index for exact identity lookup. The bundled catalog contains only regular models, with effort configured independently. Chat and commit-message selectors exclude fixed-effort variants, including standalone suffixed entries in older catalogs. There is no legacy-model setting. Incoming alias metadata can still be validated at the catalog boundary but is never expanded into selectable models.

`captureEffortPreferences()` reads window configuration without an editor/resource URI, copying the effective User/Remote and Workspace objects. The public provider callback captures it synchronously before awaiting labels/discovery. Shared `infer()` accepts an optional internal snapshot after its resource argument and defaults to catalog-only intent. Aliases pin their declared effort; canonical public requests use Workspace then User then catalog default. `catalog-default` terminates lookup and resolves a named default or provider omission. Invalid selections throw a typed `EffortError` before inference.

`resolveEffort()` produces a detached, deeply frozen spec, pricing card, canonical/backend identity and optional resolved effort. Adapters consume that typed context as an additional argument, with suffix decoding retained for callers/old catalogs without policy. Payloads and client references remain local to an invocation across retries. Connection reset cancels its in-flight tokens; revision guards prevent dispatch/accounting against a changed destination.

`getEffortModelSnapshot()` exposes immutable discovered choices and connection/catalog revisions. `ensureInitialDiscovery()` waits for the existing bounded discovery only when no completed state exists. Opening the picker, changing preferences and toggling legacy visibility refresh metadata through the existing event without resetting clients or re-probing availability. Catalog saves and destination/authentication changes retain the reset/discovery path.

`ConfigureThinkingEffort` owns one cancellable model/effort QuickPick with Back and scope controls. It revalidates revisions and policy before a serialized scope-specific write. Each write re-reads the raw target object and changes only the selected key. The last configured ID is stored separately in workspaceState as convenience state, independent of active Chat selection.

See [implementation verification](thinking-effort-verification.md) for the distinction between fixture payloads, extension-host contracts and live route acceptance.
