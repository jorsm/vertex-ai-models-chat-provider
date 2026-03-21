# Vertex Anthropic Provider for VS Code

A VS Code extension that registers **Anthropic Claude models** (via Google Cloud Vertex AI) as native language model chat providers. Once installed, the models appear alongside other models in the VS Code Copilot Chat view — no separate UI, no extra windows.

The extension automatically discovers which Claude models are available in your project and picks the best region, so there’s nothing to configure beyond your GCP Project ID.

## How It Works

The extension implements the `vscode.LanguageModelChatProvider` API to bridge VS Code's built-in Chat UI with Anthropic Claude models hosted on [Google Cloud Vertex AI Model Garden](https://cloud.google.com/vertex-ai/docs/start/explore-models). It handles:

- **Dynamic model discovery** — pings candidate models on activation and registers only the ones available in your project.
- **Auto region detection** — tries `global` first, then regional endpoints (`us-east5`, `europe-west1`, `asia-southeast1`).
- **Remote model catalog** — fetches the candidate model list from a configurable URL so your team can add models without rebuilding.
- **Message mapping** — translates VS Code chat messages (user, assistant, system, tool results, tool calls) into Anthropic’s API format.
- **Image / vision support** — images pasted into chat are sent to Claude as base64 image content blocks.
- **Streaming responses** — streams tokens back to the Chat UI in real time via the Vertex AI SDK.
- **Tool calling** — supports VS Code's native tool-calling flow, forwarding tool definitions and parsing streamed tool-use responses.
- **Authentication** — delegates to Google Cloud Application Default Credentials (ADC), so there are no API keys to manage.

## Installation

### From `.vsix` (pre-built)

1. Download the `.vsix` file from the repository:  
   [`vertex-anthropic-0.0.2.vsix`](https://github.com/jorsm/vertex-anthropic/blob/develop/vertex-anthropic-0.0.2.vsix)

2. Install it in VS Code using one of the following methods:

   **Option A — VS Code UI:**
   - Open the Extensions view (`Ctrl+Shift+X`)
   - Click the `···` menu (top-right of the Extensions sidebar) → **Install from VSIX…**
   - Select the downloaded `.vsix` file

   **Option B — Command line:**
   ```bash
   code --install-extension vertex-anthropic-0.0.2.vsix
   ```

3. Reload VS Code when prompted.

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

- **Vertex Anthropic: Refresh Models** (`Ctrl+Shift+P`) — re-runs model discovery.

### Diagnostics

Open the **Output** panel and select **Vertex Anthropic** to see detailed logs: catalog loading, region probing, message mapping, token usage, and stream lifecycle.

## Candidate Models

The extension discovers models from a JSON catalog. The default bundled catalog includes:

| Model ID             | Display Name        | Max Input | Max Output | Vision | Tools |
|----------------------|---------------------|-----------|------------|--------|-------|
| `claude-opus-4-6`    | Claude Opus 4.6     | 1M        | 128K       | ✅     | ✅    |
| `claude-sonnet-4-6`  | Claude Sonnet 4.6   | 1M        | 128K       | ✅     | ✅    |
| `claude-haiku-4-5`   | Claude Haiku 4.5    | 200K      | 64K        | ✅     | ✅    |

Only models that respond to a ping in your project are registered. Update the list by pointing `vertexAnthropic.modelCatalogUrl` to your own `models.json`.

## Development

```bash
npm run watch    # compile TypeScript in watch mode
npm run lint     # run ESLint
npm run test     # run tests
```

Press `F5` to launch the Extension Development Host. Use `Ctrl+R` inside the host window to reload after code changes.

## License

See the [LICENSE](LICENSE) file for details.
