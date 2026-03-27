# Changelog

All notable changes to the **Vertex Anthropic Provider** extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [0.1.1] — 2026-03-27

### Added

- **Gemini 3 Thinking Support** — Support for `gemini-2.0-flash-thinking-exp-01-21` with high thinking depth.
- **Thought Block Rendering** — Native support for thought signatures, allowing the model to "think" before generating an answer.
- **Parallel Tool Calling** — Support for concurrent tool execution in Gemini-based models.

## [0.1.0] — 2026-03-26

### Added

- **Multi-Vendor Dispatcher** — New `VertexChatModelDispatcher` architecture allowing the extension to support both Anthropic and Google native models.
- **Google GenAI Provider** — Integrated `VertexGoogleProvider` for native Gemini model support.
- **AI-Powered Commit Messages** — Automated commit message generation from staged git changes via `Vertex Anthropic: Generate Commit Message`.
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

- **Extension Icon** — Added official Vertex Anthropic branding image to extension via `images/` folder.

## [0.0.2] — 2026-03-21

### Added
- **Dynamic model discovery** — models are no longer hardcoded. On activation the extension pings each candidate model with a minimal `max_tokens: 1` request and registers only the ones that respond.
- **Auto region detection** — tries the `global` endpoint first, then falls back through `us-east5`, `europe-west1`, `asia-southeast1` until a working region is found. The `vertexAnthropic.region` setting has been removed.
- **Remote model catalog** — the extension fetches a JSON model catalog from a configurable URL (`vertexAnthropic.modelCatalogUrl`) with a 3-second timeout, falling back to the bundled catalog. This allows updating the model list without rebuilding the extension.
- **Image / vision support** — `LanguageModelDataPart` (images pasted into chat) are now converted to Anthropic base64 image content blocks and sent to Claude for vision analysis.
- **System message extraction** — VS Code system-role messages are properly extracted and passed as the Anthropic `system` parameter instead of being silently dropped.
- **`onDidChangeLanguageModelChatInformation` event** — notifies VS Code when the available model list changes so the model picker updates dynamically.
- **Refresh Models command** — `Vertex Anthropic: Refresh Models` (Ctrl+Shift+P) re-runs discovery on demand.
- **Config change listeners** — re-runs discovery automatically when `vertexAnthropic.projectId` or `vertexAnthropic.modelCatalogUrl` settings change.
- **Comprehensive diagnostics** — "Vertex Anthropic" output channel with detailed logging:
  - Remote catalog fetch timing and diff against bundled catalog (new/removed models)
  - Per-region ping results for every candidate model
  - Full message dump before inference: role, part type, content preview (tail-truncated), tool call details
  - Mapped messages summary showing what is actually sent to the API
  - Token usage from stream events (input, output, cache read/create)
  - Stream lifecycle (creation, chunk count, cancellation, errors)
- **Heuristic token counting** — instant `Math.ceil(length / 4)` estimate, replacing the previous API-based approach that caused VS Code to hang.
- **Multi-model catalog** — bundled `models.json` with 3 candidate Claude models (Opus 4.6, Sonnet 4.6, Haiku 4.5).

### Changed

- **Removed `vertexAnthropic.region` setting** — region is now fully auto-detected.
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
- `vertexAnthropic.projectId` and `vertexAnthropic.region` settings.