# Vertex AI Provider for VS Code

A VS Code extension that registers **Anthropic Claude** and **Google Gemini** models (via Google Cloud Vertex AI) as native language model chat providers. Once installed, the models appear alongside other models in the VS Code Copilot Chat view — no separate UI, no extra windows.

The extension automatically discovers which models are available in your project and picks the best region, so there’s nothing to configure beyond your GCP Project ID.

## How It Works

The extension implements the `vscode.LanguageModelChatProvider` API to bridge VS Code's built-in Chat UI with high-performance models hosted on [Google Cloud Vertex AI](https://cloud.google.com/vertex-ai/docs/start/explore-models). It handles:

- **Multi-Vendor Dispatching** — A unified architecture supporting both Anthropic Claude (via `VertexAnthropicProvider`) and native Google Gemini models (via `VertexGoogleProvider`).
- **Dynamic model discovery** — pings candidate models on activation and registers only the ones available in your project.
- **Auto region detection** — tries `global` first, then regional endpoints (`us-east5`, `europe-west1`, `asia-southeast1`).
- **Gemini 3 Thinking Support** — Full support for "High Thinking" models with thought block rendering and signature processing.
- **AI-Powered Commit Messages** — Generates descriptive commit messages from staged changes directly from the SCM view.
- **Interactive Usage Dashboard** — Native VS Code Webview dashboard tracking daily costs, cached tokens, and payload diagnostics via Apache ECharts.
- **API Payload Character Tracking** — Automatically computes literal byte sizing across User Text, System rules, Base64 Images, and Tool JSON calls.
- **Intelligent Prompt Caching** — Automatically injects `ephemeral` caching on systemic boundaries reducing token costs for repeating conversational setups.
- **Image / vision support** — images pasted into chat are sent to models as base64 image content blocks.
- **Streaming & Parallel Tool Calling** — streams tokens in real time and supports concurrent tool execution for Gemini models.
- **Authentication** — delegates to Google Cloud Application Default Credentials (ADC), so there are no API keys to manage.

## Installation

### From Source

```bash
git clone https://github.com/jorsm/vertex-anthropic.git
cd vertex-anthropic
npm install
npm run compile
```

Then press `F5` in VS Code to launch the Extension Development Host with the extension loaded.

## Prerequisites

### Google Cloud Authentication

The extension uses the [`@anthropic-ai/vertex-sdk`](https://www.npmjs.com/package/@anthropic-ai/vertex-sdk), which authenticates via [Application Default Credentials (ADC)](https://cloud.google.com/docs/authentication/application-default-credentials). Before using the extension, authenticate locally:

```bash
gcloud auth application-default login
```

> Your GCP project must have the Vertex AI API enabled and access to Claude models in the Model Garden.

### VS Code Version

Requires **VS Code 1.110.0** or later (for the `languageModelChatProviders` contribution point).

## Configuration

Open VS Code Settings (`Ctrl+,`) and search for **Vertex Anthropic**, or add the following to your `settings.json`:

| Setting                             | Type     | Default        | Description                                          |
|-------------------------------------|----------|----------------|------------------------------------------------------|
| `vertexAnthropic.projectId`         | `string` | `""`           | Your GCP Project ID (required)                       |
| `vertexAnthropic.modelCatalogUrl`   | `string` | *(GitHub raw)*  | URL to a remote [`models.json`](https://github.com/jorsm/vertex-anthropic/blob/develop/src/models.json) catalog. Set to empty to use only the bundled catalog. |

Example:

```jsonc
// settings.json
{
  "vertexAnthropic.projectId": "my-gcp-project-123"
}
```

The region is auto-detected — no configuration needed.

> ⚠️ The extension will show a warning on activation if `projectId` is not set.

## Usage

1. Open the **Chat view** in VS Code (Copilot icon in the sidebar, or `Ctrl+Shift+I`).
2. Click the model picker — all discovered Vertex Claude models will be listed (e.g. "Vertex Claude Opus 4.6", "Vertex Claude Sonnet 4.6").
3. Type a message and send — responses stream in real time from Vertex AI.
4. Paste images directly into the chat for vision analysis.

The models support tool calling, so they work with VS Code’s built-in agent tools and any extensions that provide tool definitions.

### Commands

- **Vertex Anthropic: Refresh Models** (`Ctrl+Shift+P`) — Re-runs model discovery across all providers.
- **Vertex Anthropic: Generate Commit Message** — Uses the selected model to generate an AI-powered commit message for staged Git changes.
- **Click Status Bar Cost** — Opens the interactive cost tracking webview.

### Status Bar & Dashboard

- An interactive **Cost Tracker** in the VS Code Status Bar updates in real time as tokens are consumed.
- The dashboard includes a direct link to the **Google Cloud Billing Console** and dynamically filters logs based on available history.

### Diagnostics

Open the **Output** panel and select **Vertex Anthropic** to see detailed logs: vendor-specific message mapping, region probing, token usage, and stream lifecycle.

## Candidate Models

The extension discovers models from an internal registry (with an optional remote fallback). The default catalog includes:

| Vendor      | Model Name                    | Context | Vision | Tools | Features             |
|-------------|-------------------------------|---------|--------|-------|----------------------|
| Anthropic   | Claude Opus 4.6               | 1M      | ✅     | ✅    | Caching, Images      |
| Anthropic   | Claude Sonnet 4.6             | 1M      | ✅     | ✅    | Caching, Images      |
| Anthropic   | Claude Haiku 4.5              | 200K    | ✅     | ✅    | Caching, Low-latency |
| Google      | Gemini 3 Flash                | 1M      | ✅     | ✅    | Parallel Tools       |
| Google      | Gemini 3 Flash (High Thinking)| 1M      | ✅     | ✅    | High Thinking        |
| Google      | Gemini 3.1 Pro (High Thinking)| 1M      | ✅     | ✅    | High Thinking        |
| Google      | Gemini 3.1 Pro                | 1M      | ✅     | ✅    | Parallel Tools       |

Only models that respond to a ping in your project are registered.

## Development

```bash
npm run watch    # compile TypeScript in watch mode
npm run lint     # run ESLint
npm run test     # run tests
```

Press `F5` to launch the Extension Development Host. Use `Ctrl+R` inside the host window to reload after code changes.

## License

See the [LICENSE](LICENSE) file for details.
