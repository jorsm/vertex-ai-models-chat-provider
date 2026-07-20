# Changelog

All notable changes to the **Google Agent Platform (Vertex AI)** extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [0.5.7] — 2026-07-20

### Added

- **Dynamic Output Token Limits** — Anthropic and Google providers now respect the `maxOutputTokens` defined in the model catalog instead of being hardcoded to 4096. This enables full-length responses (up to 128k tokens) for supported models.
- **Improved Transient Error Handling** — Added `terminated` to the list of retryable errors to handle unexpected network connection drops during initial request handshakes.
- **Configuration Guardrails** — The extension now detects missing GCP Project IDs during discovery and provides clear actionable error messages.

### Changed

- **Refactored Provider Interface** — Improved internal performance by passing model metadata directly to inference methods, eliminating redundant disk I/O for catalog lookups.
- **Fail-Closed Authentication** — Explicitly selected Service Accounts now strictly adhere to the selection; the extension will no longer fall back to ambient system credentials if the selected method fails.

## [0.5.6] — 2026-07-17

### Changed

- **Workspace-Host Remote Support** — The extension now runs with the workspace so its language-model provider is available to Copilot Chat in Remote SSH, Dev Containers, Codespaces, and similar environments. Remote users must install the extension in the remote workspace and provide ADC or a Service Account there.
- **Fail-Closed Authentication** — A missing or invalid explicitly selected Service Account no longer falls back to an ambient ADC identity.
- Service Account JSON pasted into the extension is now masked while entering it.

## [0.5.5] — 2026-07-15

### Added

- ~~**Remote Development Support** — The extension can now run in either the local/UI or workspace extension host, supporting Remote SSH, Dev Containers, Codespaces, and similar VS Code remote workflows.~~
- **Portable Service Account Imports** — Service Account JSON files selected through VS Code are imported as encrypted snapshots into `SecretStorage`, so authentication no longer depends on a path being accessible from the extension host.
- **Stored Credential Management** — Added a command to remove stored Service Accounts. Re-importing an existing friendly name can replace its stored credential after confirmation.

### Changed

- **Local ADC Recovery** — When the extension runs locally against a remote workspace, the authentication recovery action runs the local `gcloud` installation and refreshes models after a successful login.
- **Optional Git Integration** — AI commit-message generation now activates the built-in Git extension when available and degrades gracefully when Git runs in a different extension host. Chat models, workspace file access, and tool calling remain available.
- **URI-Based Catalog Access** — Custom model catalogs now use VS Code's URI-aware filesystem APIs so workspace catalogs work across local and remote filesystems.

### Fixed

- **Remote Authentication Boundary** — Fixed the one-click ADC login action opening a terminal on the remote machine when the extension was installed locally.
- **Service Account File Boundary** — Fixed selected Service Account files being reduced to host-specific filesystem paths.

## [0.5.4] — 2026-06-19

### Added

- **Custom Model Catalogs** — Added support for user-level and workspace-level `models.json` overrides. Teams can now commit `.vscode/models.json` to share model configurations, while individuals can maintain private catalogs in extension storage.
- **Dynamic Catalog Resolution** — Implemented a prioritized resolution chain (Workspace > User > Bundled) for model discovery and usage tracking.
- **JSON Schema Validation** — Integrated automatic schema validation and autocomplete for custom model catalogs, ensuring correct configuration of vendors, pricing, and capabilities.
- **Auto-Discovery Watcher** — Saving a custom `models.json` now automatically triggers model re-discovery and refreshes the Copilot Chat model picker.

## [0.5.3] — 2026-06-11

### Added

- **Claude Fable 5 Support** — Added support for the high-end `Claude Fable 5` model via Vertex AI.

## [0.5.2] — 2026-06-03

### Added

- **xAI Grok 4.2 Support** — Added support for `Grok 4.2 Reasoning` via Vertex AI Models-as-a-Service (MaaS). Includes native reasoning extraction for deep-thinking responses.

## [0.5.1] — 2026-06-01

### Fixed

- **Removed Labels from Claude** — Removed GCP resource labels from Claude requests as the Anthropic SDK breaks when GCP labels are used with Anthropic models.
- **Zod Version Fix** — Fixed Zod version dependency that was preventing a clean installation for the OpenAI compatible version.

## [0.5.0] — 2026-05-31

### Added

- **Rebranded to Google Agent Platform** — Renamed the extension to "Google Agent Platform for Copilot Chat" to align with Google Cloud's updated product branding.
- **Model-as-a-Service (MaaS) Support** — Integrated `VertexMaaSProvider` for high-performance open-weight models (`Qwen3-Coder`, `DeepSeek V3.2`, `Kimi K2`). Includes native `reasoning_content` extraction to ensure clean responses from "thinking" models.
- **Private Service Account Auth** — Support for pasting Service Account JSON keys directly into secure VS Code Secret Storage, enabling "Zero-Pollution" authentication without system-wide environment variables.
- **Enhanced Status Bar Visibility** — Added dynamic icons reflecting the active auth method and a detailed tooltip showing the source of the Project ID (Workspace, User, or Auto-detected).
- **Custom Resource Labeling** — Added settings for custom labels at the request level, enabling granular cost attribution in the Google Cloud Console.

### Improved

- **Unified Logger** — Centralized all diagnostic output into a unified `Logger` utility for better troubleshooting and cleaner output channel management.
- **Project ID Resolution** — Enhanced the logic for Project ID enforcement and auto-discovery to ensure consistent billing across multi-root workspaces.


## [0.4.5] — 2026-05-27

### Fixed

- **Gemini 3.5 Thought Signature Leak** — Fixed an issue where Gemini 3.5 models (especially `gemini-3.5-flash-high`) would leak internal thought signatures (e.g. `gemini-3.5-flash-high\5R+S41tN...`) into the chat output. The provider now automatically detects and strips these headers while preserving the clean answer text.

### Added

- **Context Window Heuristic** — Improved token counting to estimate context window usage more accurately, helping prevent requests that exceed model limits.
- **Token Usage Reporting** — Token estimation is now consolidated into a shared utility and reported to VS Code via the `LanguageModelDataPart` API for better usage tracking.

### Improved

- **Reasoning Chain Preservation** — Thought signatures are now properly managed and re-attached to model responses, preserving the model's reasoning quality across chat turns.
- **Parallel Tool Calling** — Tool responses are now merged correctly into a single user turn, ensuring compatibility with Gemini's parallel tool calling protocol and preventing interleaved response issues.

## [0.4.4] — 2026-05-27

### Added

- **CI/CD Strengthening** — Implemented a new Continuous Integration pipeline via GitHub Actions to verify builds and linting on every push and pull request.
- **Build Reliability Guardrails** — Integrated Husky pre-commit hooks and enabled stricter TypeScript compiler options (`noImplicitReturns`, `noUnusedParameters`, etc.) to catch errors before they reach the repository.

### Changed

- **Renamed Label Prefix** — Updated cost attribution labels to `vscode-vertex-ai-user` and `vscode-vertex-ai-project` for better identification and compliance with GCP labeling constraints.

## [0.4.3] — 2026-05-27

### Added

- **Opt-in GCP Resource Labeling** — Added support for propagating user email and project name as labels to Vertex AI requests, enabling granular cost tracking and attribution in the Google Cloud Console. This feature is **disabled by default** to respect user privacy.
- **Dynamic Label Resolution** — Labels are now resolved at the request level, prioritizing the workspace folder of the active text editor to support multi-root setups.

### Changed

- **Dependency Update** — Upgraded `@google/genai` to `v2.6.0` to ensure compatibility with latest API features and improved label logging.

## [0.4.2] — 2026-05-20

### Added

- **Gemini 3.5 Flash Support** — Added support for the new `gemini-3.5-flash` model and its high-reasoning variant `gemini-3.5-flash-high`.
- **In-UI Pricing Display** — Added live pricing information directly to the model picker details and tooltips, allowing users to see token costs ($/1M) before selecting a model.

## [0.4.1] — 2026-05-19

### Fixed

- **Discovery Race Condition** — Resolved an issue where sending a chat message immediately after VS Code startup would fail with an "Authentication not set up" error. The dispatcher now gracefully awaits the completion of background model discovery before processing inference requests.

## [0.4.0] — 2026-05-14

### Added

- **VS Code 1.120 Compatibility** — Implemented polymorphic metadata mapping to ensure seamless integration with the new organized Chat Model Picker introduced in VS Code 1.120.
- **Cross-Platform Build Support** — Switched the `clean` script to use `rimraf`, resolving "command not found" errors on Windows environments.
- **Duration-Based Retries** — Transitioned the retry utility from attempt-based limits to a duration-based approach (defaulting to 30 minutes).
- **Retry Notifications** — Added user notifications when failures persist beyond one minute, informing users of the estimated remaining retry time.

### Improved

- **Model Visibility** — Injected internal metadata properties (`isUserSelectable`, explicit `vendor` slugs) to prevent models from being filtered out by the Copilot Chat application layer.
- **UI Responsiveness** — Optimized model discovery to return the local catalog immediately, preventing "empty list" states during background probing.
- **Performance** — Optimized `getUsageInRange` in the Usage Tracker with concurrent file I/O for faster dashboard loading.
- **API Compliance** — Aligned provider registration and model identification logic with the latest `vscode.lm` API requirements.

### Fixed

- **Model Selection Issues** — Resolved a conflict where Vertex models were unselectable in newer VS Code versions due to naming and vendor ID mismatches.

## [0.3.1] — 2026-04-27

### Added

- **Enhanced Retry Logic** — Added support for retrying common network errors (ECONNRESET, ETIMEDOUT, etc.) and specific transient error messages from Google APIs.

### Improved

- **Code Maintainability** — Refactored the internal retry mechanism to reduce cognitive complexity and improve logging transparency.

## [0.3.0] — 2026-04-26

### Added

- **ID Migration** — The extension has been officially renamed and expanded under a new identifier (`jorsm.vertex-ai-models-chat-provider`). The old `jorsm.vertex-anthropic` extension is now deprecated.

## [0.2.6] — 2026-04-23

### Fixed

- **Tool Schema Validation** — Resolved `400 INVALID_ARGUMENT` errors caused by unexpected tool properties. Implemented a Hybrid Discovery Allowlist that fetches Google Vertex's supported JSON Schema properties on the fly.
- **Required Fields Fix** — Fixed an issue where the sanitizer was incorrectly stripping out tool parameter arguments within the `properties` map, causing requirement validation mismatch on Google's end.

## [0.2.5] — 2026-04-21

### Added

- **Demo Visuals** — Added a demonstration GIF to the README to better illustrate the setup and authentication workflow.

## [0.2.4] — 2026-04-20

### Added

- **Interactive Authentication Flow** — Added a "Login with gcloud" button to error notifications when credentials expire, making it easier to re-authenticate.
- **Smart Terminal Monitoring** — Uses the VS Code Shell Integration API to watch the authentication terminal in real-time, automatically refreshing models the moment login is successful.
- **New Model Support** — Added support for **Claude Opus 4.7** (released April 16, 2026).
- **Loud Auth Failures** — Improved state management to clear stale models and prevent Copilot from silently falling back to other models when authentication fails.

### Fixed

- **Build Stabilization** — Resolved TypeScript compilation errors in the Google provider related to stream type inference.
- **Auth Error Clarity** — Improved detection of expired Google Cloud credentials across all provider paths.

## [0.2.3] — 2026-04-16

### Added

- **Automatic Retry with Exponential Backoff** — Implemented automatic retries for transient errors like `429 Too Many Requests` and `503 Service Unavailable` to improve reliability during high usage.
- **Detailed Retry Logging** — Added structured logging of retry attempts and backoff delays in the output channel for better transparency.

## [0.2.2] — 2026-04-15

### Added

- **Windows Compatibility** — Verified extension functionality on Windows VM.

### Changed

- **Tool Schema Sanitization** — Improved recursive removal of unsupported keys (like `enumDescriptions` and `examples`) from tool definitions to ensure compatibility with the Vertex AI Gemini API.

## [0.2.1] — 2026-04-15

### Fixed

- **400 Bad Request Fix** — Resolved an issue where Gemini API would reject tools containing unsupported JSON schema fields (like `enumDescriptions`, `examples`, or `markdownDescription`).

### Added

- **Debug Command** — Added `Vertex AI: Dump Installed Tools Schema` command to inspect schemas of all installed tools in the workspace for easier troubleshooting.

### Changed

- **Schema Validation** — Implemented a strict allowlist for tool input schemas to ensure compatibility with Gemini's OpenAPI-based validation.

## [0.2.0] — 2026-04-15

### Changed

- **Extension Renamed** — "Vertex Anthropic" has been renamed to "Vertex AI Models Chat Provider" to better reflect the deep integration with Google Gemini and its multi-provider support.
- **Settings Migration** — The setting keys have changed from `vertexAnthropic.*` to `vertexAiChat.*`. Existing configuration values will automatically migrate on the first launch.
- **Improved UI** — The model picker now uses the native `detail` field to show "Vertex AI" instead of prefixing model names, matching the VS Code native look.
- **Refined Output Channels** — Differentiated output channel names (Dispatcher, Google Provider, Anthropic Provider, etc.) to improve troubleshooting.
- **Enhanced Documentation** — Complete README rewrite focusing on professional usage and the benefits of Project-based authentication.

## [0.1.3] — 2026-03-29

### Added

- **Extension Bundling** — Integrated `esbuild` to bundle the extension into a single file, significantly reducing the package size.
- **Improved Launch Configurations** — Added "Run Extension (Bundled)" launch target for easier testing of the production-ready bundle.

### Changed

- **Optimized Output** — Reduced the extension's installation size from ~22MB to ~2MB by excluding unnecessary `node_modules` and source files from the final package.
- **Developer Workflow** — Added `bundle`, `bundle-dev`, and `watch-bundle` scripts for faster and more reliable development.

## [0.1.2] — 2026-03-29

### Added

- **New Documentation** — Added comprehensive documentation for extension features and model providers.

### Changed

- **User Interface** — Refactored output channel behavior to avoid forced focus during active generations.
- **Documentation Update** — Enhanced details on multi-vendor architecture and Gemini integration.

## [0.1.1] — 2026-03-27

### Added

- **Gemini 3 Thinking Support** — Support for `gemini-2.0-flash-thinking-exp-01-21` with high thinking depth.
- **Thought Block Rendering** — Native support for thought signatures, allowing the model to "think" before generating an answer.
- **Parallel Tool Calling** — Support for concurrent tool execution in Gemini-based models.

## [0.1.0] — 2026-03-26

### Added

- **Multi-Vendor Dispatcher** — New `VertexChatModelDispatcher` architecture allowing the extension to support both Anthropic and Google native models.
- **Google GenAI Provider** — Integrated `VertexGoogleProvider` for native Gemini model support.
- **AI-Powered Commit Messages** — Automated commit message generation from staged git changes via `Vertex AI Models Chat Provider: Generate Commit Message`.
- **In-Input Generation Status** — Visual progress indicator in the VS Code chat input box during active generations.
- **Dashboard Billing Link** — Added a direct button to the Google Cloud Console billing dashboard for easier cost management.
- **Dynamic Log Filtering** — The dashboard now automatically detects the earliest available log date for usage metrics.

### Changed

- **Model Registry Refactor** — Switched from remote JSON fetching to a more robust internal provider registry.
- **Updated Pricing Catalog** — Refreshed `models.json` with the latest token pricing and context window limits for all Gemini and Claude models.
- **Enhanced Provider Logging** — More detailed message mapping and diagnostic output for multi-vendor requests.

## [0.0.4] — 2026-03-22

### Added

- **Interactive Webview Dashboard** — Native VS Code Webview dashboard tracking daily costs, cached tokens, and payload diagnostics via Apache ECharts.
- **API Payload Character Tracking** — Automatically computes literal byte sizing across User Text, System rules, Base64 Images, and Tool JSON calls.
- **Intelligent Prompt Caching** — Automatically injects `ephemeral` caching on systemic boundaries reducing token costs for repeating conversational setups.
- **Native Status Bar Item** — A persistent status bar icon displaying global live inference costs.
- **Local Persistence layer** — Native filesystem `YYYYMMDD.json` batching engine safely persisting AI costs mapped tightly to Local Timezones.
- **Webview Model Selector** — ECharts natively filters usage metrics via dropdown mapping to invoked Model histories.

## [0.0.3] — 2026-03-22

### Added

- **Extension Icon** — Added official Vertex AI Models Chat Provider branding image to extension via `images/` folder.

## [0.0.2] — 2026-03-21

### Added

- **Dynamic model discovery** — models are no longer hardcoded. On activation the extension pings each candidate model with a minimal `max_tokens: 1` request and registers only the ones that respond.
- **Auto region detection** — tries the `global` endpoint first, then falls back through `us-east5`, `europe-west1`, `asia-southeast1` until a working region is found. The `vertexAiChat.region` setting has been removed.
- **Remote model catalog** — the extension fetched a JSON model catalog from a remote URL. (Note: This has been replaced by a more robust internal provider registry).
- **Image / vision support** — `LanguageModelDataPart` (images pasted into chat) are now converted to Anthropic base64 image content blocks and sent to Claude for vision analysis.
- **System message extraction** — VS Code system-role messages are properly extracted and passed as the Anthropic `system` parameter instead of being silently dropped.
- **`onDidChangeLanguageModelChatInformation` event** — notifies VS Code when the available model list changes so the model picker updates dynamically.
- **Refresh Models command** — `Vertex AI Models Chat Provider: Refresh Models` (Ctrl+Shift+P) re-runs discovery on demand.
- **Config change listeners** — re-runs discovery automatically when `vertexAiChat.projectId` settings change.
- **Comprehensive diagnostics** — "Vertex AI Models Chat Provider" output channel with detailed logging:
  - Remote catalog fetch timing and diff against bundled catalog (new/removed models)
  - Per-region ping results for every candidate model
  - Full message dump before inference: role, part type, content preview (tail-truncated), tool call details
  - Mapped messages summary showing what is actually sent to the API
  - Token usage from stream events (input, output, cache read/create)
  - Stream lifecycle (creation, chunk count, cancellation, errors)
- **Heuristic token counting** — instant `Math.ceil(length / 4)` estimate, replacing the previous API-based approach that caused VS Code to hang.
- **Multi-model catalog** — bundled `models.json` with 3 candidate Claude models (Opus 4.6, Sonnet 4.6, Haiku 4.5).

### Changed

- **Removed `vertexAiChat.region` setting** — region is now fully auto-detected.
- **Provider vendor** changed from `"Anthropic"` to `"Google Cloud Vertex AI"`.
- **Model names** in the picker now prefixed with `Vertex` (e.g. "Vertex Claude Opus 4.6").

### Fixed

- Models not appearing in the VS Code model picker (missing `onDidChangeLanguageModelChatInformation` event).
- Inference hanging on first use (serial token-counting API calls were blocking the extension host).
- System messages being silently dropped instead of passed to Claude.
- Wrong region (`us-central1`) — Claude models are available on `us-east5`, `europe-west1`, `asia-southeast1`, and the `global` endpoint.
- Unknown part types in messages silently ignored — now logged with property details for debugging.

## [0.0.1] — 2026-03-19

### Added

- Initial release.
- Basic `LanguageModelChatProvider` implementation for a single hardcoded Claude model.
- Streaming responses via `@anthropic-ai/vertex-sdk`.
- Tool calling support (tool definitions, streamed tool-use responses).
- Authentication via Google Cloud Application Default Credentials (ADC).
- `vertexAiChat.projectId` and `vertexAiChat.region` settings.
