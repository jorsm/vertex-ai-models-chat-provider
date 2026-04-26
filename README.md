# Vertex AI Models Chat Provider for VS Code

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![VS Code](https://img.shields.io/badge/VS%20Code-1.110.0%2B-blue)](https://code.visualstudio.com/)

### **Native Gemini & Claude, powered by Vertex AI.**

Experience enterprise-grade AI directly within the **standard VS Code Chat panel**.

<p align="center">
  <img src="images/demo.gif" alt="Vertex AI Chat Demo" width="800">
</p>

This extension registers **Google Gemini** and **Anthropic Claude** as first-class providers—**no separate UI, no extra windows, no friction.**

- **🔒 Zero API Keys** — Securely uses your native Google Cloud identity.
- **🏢 Automatic Billing** — Costs follow your project settings as you switch workspaces.
- **⚡ Native Integration** — First-class support for Gemini 3 and Claude within Copilot Chat.
- **📊 Cost Transparency** — Real-time session tracking and interactive usage dashboard.

---

## ☁️ Google Cloud Prerequisites

> ⚠️ **Important:** Before using this extension, ensure your Google Cloud project is properly configured to avoid authentication or permission errors.
>
> 1. **Enable APIs**: Enable the **Vertex AI API** (`aiplatform.googleapis.com`) in the Cloud Console ([Docs](https://cloud.google.com/vertex-ai/docs/start/cloud-environment)).
> 2. **IAM Roles**: Your account requires the **Vertex AI User** (`roles/aiplatform.user`) role ([Docs](https://cloud.google.com/vertex-ai/docs/general/access-control)).
> 3. **Model Access**: For Anthropic Claude models, find them in the **Vertex AI Model Garden** and click **Enable** ([Docs](https://cloud.google.com/vertex-ai/generative-ai/docs/partner-models/use-claude)).

## 🚀 Quick Start

1. **Install**: Find **Vertex AI Models Chat Provider** in the VS Code Marketplace and click Install.
2. **Authenticate**: Ensure you have the [Google Cloud SDK](https://cloud.google.com/sdk/docs/install) installed and run:

    ```bash
    gcloud auth application-default login
    ```

3. **Configure**: Open VS Code Settings (`Ctrl+,`) and set your **GCP Project ID** in `vertexAiChat.projectId`.
4. **Chat**: Open the Chat panel (`Ctrl+Shift+I`) and select a **Vertex** model from the picker.

---

## 🌟 Why Project-Based Authentication?

This extension uses your **GCP Project ID** and **Application Default Credentials (ADC)** instead of traditional API keys. This approach offers several professional advantages:

- **🔒 Secure by Design**: Credentials stay in your system's secure store via `gcloud`. There are no sensitive API keys to paste, store in plain text, or rotate manually.
- **🏢 Automatic Billing Switching**: By setting the Project ID in your workspace's `.vscode/settings.json`, billing for LLM usage automatically switches as you move between different client or internal projects.
- **📈 Centralized Governance**: Organization admins can manage model access and quotas centrally through the Google Cloud Console, which automatically applies to all developers using that Project ID.
- **⚡ Consistent Performance**: Leveraging your own GCP project quotas ensures you aren't sharing rate limits with other users on a global API key.

---

## ✨ Key Features

- **🧠 Advanced Gemini Support**: Full support for **Gemini 3 Flash & Pro**, including "High Thinking" modes with thought block rendering and signature preservation.
- **⚡ Anthropic Performance**: Native support for **Claude Opus, Sonnet, and Haiku**, featuring automated **Prompt Caching (Ephemeral)** to reduce latency and costs for long conversations.
- **🔑 Actionable Auth**: Improved detection of expired credentials with a one-click "Login with gcloud" fix directly from VS Code.
- **🪄 AI Commit Messages**: Generate professional, conventional commit messages from staged Git changes with one click from the Source Control view.
- **📊 Local Usage Dashboard and Real Time Costs Estimation**: An interactive, ECharts-powered dashboard to track your individual costs, token consumption, and payload metrics—all stored locally and updated in real time.

- **🔍 Smart Discovery**: Automatically probes regional endpoints (`global`, `us-east5`, `europe-west1`, `asia-southeast1`) to find and register only the models available in your specific GCP project.
- **👁️ Multimodal Vision**: Paste images directly into chat for analysis by vision-capable models like Claude 4.6 and Gemini 3.
- **🛠️ Tool Calling**: Support for streaming parallel tool execution, enabling models to interact with VS Code agents and external tools.

---

## 🤖 Supported Models

| Vendor        | Model Family | Versions Supported                       | Features                      |
| :------------ | :----------- | :--------------------------------------- | :---------------------------- |
| **Anthropic** | Claude       | Opus 4.7,Opus 4.6, Sonnet 4.6, Haiku 4.5 | Vision, Tools, Caching        |
| **Google**    | Gemini       | 3 Flash, 3.1 Pro                         | High Thinking, Parallel Tools |

---

## ⚙️ Configuration

| Setting                           | Type      | Default | Description                                        |
| :-------------------------------- | :-------- | :------ | :------------------------------------------------- |
| `vertexAiChat.projectId`          | `string`  | `""`    | **Required.** Your Google Cloud Project ID.        |
| `vertexAiChat.hideBillingWarning` | `boolean` | `false` | Hide the cost estimation warning in the dashboard. |

---

## 📂 Diagnostics & Logs

For detailed request/response mapping and troubleshooting:

1. Open the **Output** panel (`Ctrl+Shift+U`).
2. Select **Vertex AI Models Chat Provider** from the dropdown.
3. View region probing results, token usage metadata, and raw API transformations.

---

## 🛠️ Installation from Source

If you prefer to build the extension manually:

1. Clone the repository:

    ```bash
    git clone https://github.com/jorsm/vertex-anthropic.git
    ```

2. Install dependencies:

    ```bash
    npm install
    ```

3. Compile and launch:
    - Press `F5` in VS Code to launch the **Extension Development Host**.
    - Or run `npm run compile` to build the TypeScript source.

---

## 📜 License

Distributed under the **MIT License**. See [LICENSE](LICENSE) for more information.
