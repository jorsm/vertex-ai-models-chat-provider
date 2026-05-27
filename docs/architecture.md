# docs/architecture.md

> **Overview**
> This document describes the architecture and API surface of the Vertex AI Models Chat Provider. The extension acts as a dispatcher between VS Code's Language Model API and various Google Cloud Vertex AI backends (Gemini and Anthropic Claude).

## Table of Contents
- [Table of Contents](#table-of-contents)
- [Core Concepts](#core-concepts)
- [API Reference](#api-reference)
    - [VertexChatModelDispatcher](#vertexchatmodeldispatcher)
    - [ModelSpec](#modelspec)
    - [ModelCatalog](#modelcatalog)
    - [DiscoveryResult](#discoveryresult)
    - [activate](#activate)
    - [runDiscovery](#rundiscovery)
- [Examples](#examples)

---

## Core Concepts
The extension follows a provider-based architecture centered around the `VertexChatModelDispatcher`. 

- **Multi-Vendor Support**: It manages a registry of specific vendor providers (e.g., `VertexAnthropicProvider`, `VertexGoogleProvider`) that handle the nuances of different LLM protocols while exposing a unified interface to VS Code.
- **Dynamic Discovery**: Instead of hardcoding endpoints, the extension performs region probing. It iterates through prioritized GCP regions (global, us-east5, etc.) to identify where specific models are enabled for the user's project.
- **Unified Usage Tracking**: All interactions are intercepted to record token consumption (including Gemini high-thinking blocks and Anthropic prompt caching) into a local `UsageTrackerService`.
- **VS Code Integration**: It implements the `vscode.LanguageModelChatProvider` interface, making Vertex AI models appear as native options in the Copilot Chat model picker.

## API Reference

### VertexChatModelDispatcher
[source](../src/VertexChatModelDispatcher.ts)
The central class that implements `vscode.LanguageModelChatProvider`. It manages model discovery, provider registration, and request dispatching.

**Methods:**
- `onDidChangeLanguageModelChatInformation`: Event that fires when the available model list changes, prompting VS Code to refresh model information.
- `updateLabels()`: Triggers an asynchronous update of metadata labels by fetching the current authenticated `gcloud` account email and propagating it to all active providers. This supports cost tracking and attribution features.
- `discoverModelsAndRegion()`: Probes GCP regions to find available models based on the local catalog. It prevents concurrent discovery attempts by tracking and returning an active discovery promise if one is already in progress. Returns a `DiscoveryResult` and fires the change event upon successful discovery or failure.
- `setProjectId(projectId: string)`: Updates the active GCP project and resets discovery state.
- `clearModels()`: Clears all available models and notifies VS Code of the change. Useful when authentication fails to prevent stale models from being used.
- `provideLanguageModelChatInformation(...)`: Returns the list of discovered models to VS Code. It returns the set of models found during the discovery process, falling back to the full set of candidate models from the local catalog if discovery is not yet complete. It enriches model metadata with regional details, pricing summaries (input/output per 1M tokens) in the `detail` and `tooltip` fields, vendor information (`google-vertex`), and visibility flags (`isUserSelectable`) to ensure compatibility with VS Code 1.120+ and Copilot Chat.
- `provideTokenCount(...)`: Calculates or estimates token counts for messages. It uses provider-specific counting logic if available, falling back to a heuristic of ~4 characters per token (supporting both raw strings and `LanguageModelChatRequestMessage` with `LanguageModelTextPart` content).
- `provideLanguageModelChatResponse(...)`: Streams the chat response from the appropriate vendor provider. It automatically waits for any in-progress model discovery or label resolution to complete (synchronizing on internal promises) before starting inference. It resolves and injects request-level labels (such as `user` from gcloud identity and `project` from the workspace name) for cost attribution if enabled in settings. It records detailed usage (input, output, cache_read, cache_create, and total character counts) via the `UsageTrackerService`.
- `getAnthropicProvider()`: Returns the registered `VertexAnthropicProvider` instance.
- `getGoogleProvider()`: Returns the registered `VertexGoogleProvider` instance.

### ModelSpec
[source](../src/VertexChatModelDispatcher.ts)
Interface defining the metadata and capabilities for a supported model.

**Properties:**
- `id`: Unique identifier for the model.
- `vendor`: The vendor name (e.g., "google", "anthropic").
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

### activate
[source](../src/extension.ts)
The main entry point for the VS Code extension. It handles:
- Configuration migration from legacy settings (`vertexAnthropic` to `vertexAiChat`), including Project ID and billing warning preferences.
- Initializing the `UsageTrackerService` and `CostStatusBar`.
- Registering the `VertexChatModelDispatcher` as a language model chat provider for the `google-vertex` vendor.
- Registering extension commands including:
    - `claudeBilling.showDashboard`: Opens the usage dashboard webview.
    - `vertexAiChat.refreshModels`: Manually triggers the model discovery process.
    - `vertexAiChat.dumpTools`: Dumps the schema of all installed language model tools to an output channel for debugging.
    - `vertexAiChat.generateCommitMessage`: Generates AI-powered commit messages from staged changes using the Google provider.
- Watching for configuration changes (specifically `vertexAiChat.projectId`) to trigger re-discovery and update the active project.

### runDiscovery
[source](../src/extension.ts)
A helper function that triggers the model discovery process on the dispatcher and provides UI feedback (Information, Warning, or Error messages) to the user based on the results.

In the event of a `VertexAuthenticationError`, it clears stale models and provides a specialized workflow that:
- Prompts the user to login via the Google Cloud SDK (`gcloud`).
- Automatically opens a terminal and executes the `gcloud auth application-default login` command with the current project ID and `--quiet` flag.
- Uses VS Code's shell integration to monitor terminal output in real-time via `onDidStartTerminalShellExecution`, automatically re-triggering discovery as soon as "Credentials saved to file" is detected in the terminal stream.

---

## Examples
*(High-level explanation of the architecture, dependencies, or primary design patterns used in this code).*