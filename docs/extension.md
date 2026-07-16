# docs/extension.md

> **Overview**
> This module serves as the primary entry point for the Vertex AI Models Chat Provider extension. It manages the extension's lifecycle, handles configuration migration, initializes core services, and registers commands and providers with VS Code.

## Table of Contents
- [Table of Contents](#table-of-contents)
- [Core Concepts](#core-concepts)
- [API Reference](#api-reference)
    - [activate](#activate)
    - [runDiscovery](#rundiscovery)
- [Examples](#examples)

---

## Core Concepts
The extension follows a standard VS Code extension architecture with several specialized components:

*   **Extension Activation**: Triggered via `onStartupFinished`. It ensures the `projectId` is configured before proceeding with service initialization.
*   **Settings Migration**: Automatically migrates `projectId` and `hideBillingWarning` settings from the legacy `vertexAnthropic` configuration namespace to the current `vertexAiChat` namespace.
*   **Service Initialization**: Orchestrates the `UsageTrackerService`, `CostStatusBar`, and `VertexChatModelDispatcher`.
*   **Provider Registration**: Registers a `LanguageModelChatProvider` under the name "Google Cloud Vertex AI", allowing the models to be used within the native VS Code Chat interface.
*   **Model Discovery**: Implements a discovery mechanism that probes GCP regions to identify available models. This process is triggered on activation, configuration changes, or manually via command.
*   **Remote Host Support**: Runs in the workspace extension host. In a remote window, the extension must be installed remotely and uses authentication available in that environment.
*   **Command Registration**: Exposes commands for dashboard access, model refresh, tool debugging, Service Account lifecycle management, and optional AI-powered commit-message generation.

## API Reference

### activate
[source](../src/extension.ts)
Initializes the extension's internal state and registers its contributions with VS Code.

**Parameters:**
- `context`: `vscode.ExtensionContext` - The context in which the extension is running, used for subscriptions and storage.

**Functionality:**
1.  Loads `vertexAiChat` configuration.
2.  Performs migration from `vertexAnthropic` if necessary.
3.  Initializes the `UsageTrackerService` and `CostStatusBar`.
4.  Instantiates the `VertexChatModelDispatcher`.
5.  Registers the following commands:
    - `claudeBilling.showDashboard`: Opens the local usage and cost dashboard.
    - `vertexAiChat.refreshModels`: Manually triggers the model discovery process.
    - `vertexAiChat.dumpTools`: Dumps metadata and schemas for all installed `vscode.lm.tools` to an output channel for debugging.
    - `vertexAiChat.generateCommitMessage`: Invokes the AI logic to generate a commit message when the Git extension API is available in the same extension host.
    - `vertexAiChat.setServiceAccountKey`: Validates and stores pasted Service Account JSON in `SecretStorage`.
    - `vertexAiChat.setServiceAccountPath`: Imports a selected JSON file as a secure snapshot without modifying the source file.
    - `vertexAiChat.removeServiceAccount`: Removes only this extension's copy of a named credential; it does not change the Google Cloud key.
    - `vertexAiChat.selectAuthMethod`: Selects a stored Service Account, imports a new one, removes one, or switches to ADC.
    - `vertexAiChat.clearAuthMethod`: Resets the workspace authentication method to ADC.
6.  Registers the chat provider with the `vscode.lm` API.
7.  Starts an initial background discovery of models.
8.  Sets up a listener for `onDidChangeConfiguration` to update the project ID and re-run discovery if changed.

### runDiscovery
[source](../src/extension.ts)
An internal helper function that coordinates with the `VertexChatModelDispatcher` to find available models in supported GCP regions.

**Parameters:**
- `provider`: `VertexChatModelDispatcher` - The dispatcher instance used to perform the discovery.

**Behavior:**
- Calls `provider.discoverModelsAndRegion()`.
- Displays an information message listing the available models and the discovered region upon success.
- Displays a warning if no models are found or an error message if the discovery process fails.
- On ADC authentication failure, offers a `gcloud` recovery action in the workspace environment. Confirmed success triggers discovery again.
- On a missing or invalid explicitly selected Service Account, fails closed and offers the authentication-method picker instead of falling back to ADC.

## Examples

### Manual Model Refresh
Users can manually trigger the discovery process if they have recently updated their GCP Model Garden or changed project permissions.
1. Open the Command Palette (`Ctrl+Shift+P`).
2. Run `Vertex AI Models Chat Provider: Refresh Models`.

### Debugging LM Tools
To see which tools are currently available to the language models:
1. Open the Command Palette (`Ctrl+Shift+P`).
2. Run `Vertex AI Models Chat Provider: Tools Dump`.
3. An output channel will open showing the names, descriptions, and input schemas of all registered tools.
