# Google Agent Platform for Copilot Chat

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![VS Code](https://img.shields.io/badge/VS%20Code-1.110.0%2B-blue)](https://code.visualstudio.com/)

Use Google Gemini, Anthropic Claude, and selected MaaS models directly in VS Code Copilot Chat. The extension authenticates with Google Cloud, sends requests through Google Agent Platform (Vertex AI), and bills the Google Cloud project you select.

## What you get

- Native VS Code Chat models—no API keys or separate chat UI.
- Application Default Credentials (ADC) or Service Account credentials stored in VS Code `SecretStorage`.
- Project-aware model discovery, local usage estimates, and an optional cost dashboard.
- Vision, tool calling, Claude prompt caching, and Gemini thinking support where the model supports them.
- Optional request labels for Gemini and Claude PayGo billing attribution.

## Before you start

You need a billable Google Cloud project with the Agent Platform API enabled and an identity with the [Agent Platform User role](https://docs.cloud.google.com/iam/docs/roles-permissions/aiplatform#aiplatform.user). Enable Claude models you plan to use in [Model Garden](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/partner-models/claude).

## Quick start

1. Install **Google Agent Platform for Copilot Chat** from the VS Code Marketplace.
2. Authenticate with one of these options:

   - **ADC:** run `gcloud auth application-default login` in the same environment where the extension runs.
   - **Service Account:** run **Google Agent Platform: Paste Service Account JSON Key** or **Import Service Account JSON File**.

3. Set the project that owns discovery and billing in VS Code settings:

   ```json
   {
     "vertexAiChat.projectId": "my-gcp-project-id"
   }
   ```

4. Open VS Code Chat and select a **Google Agent Platform** model. If no model appears, run **Google Agent Platform: Refresh Models**.

For Remote SSH, Dev Containers, and Codespaces, install the extension and configure authentication in the remote workspace environment. See the [setup guide](https://github.com/jorsm/vertex-ai-models-chat-provider/wiki/Setup-&-Configuration).

## Supported models

Models are discovered against your selected project and available region; the picker shows only models your project can access.

| Provider | Current catalog | Details |
| :-- | :-- | :-- |
| Google | Gemini 3.8, 3.7, 3.6, 3.5, and 3 Flash; Gemini 3.1 Pro | [Gemini model documentation](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini) |
| Anthropic | Claude Fable 5.1 and 5; Opus 5 and 4.8; Sonnet 5 and 4.6; Haiku 4.5 | [Claude on Google Cloud](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/partner-models/claude) |
| MaaS | Grok 4.2 Reasoning, DeepSeek V3.2, Qwen3 Coder 480B, Kimi K2 Thinking | [MaaS guide](https://github.com/jorsm/vertex-ai-models-chat-provider/wiki/Model-as-a-Service-(MaaS)) |

Claude Fable 5 and 5.1 require Model Garden access and are subject to Google's [Advanced AI Safety Addendum](https://cloud.google.com/terms/advanced-ai-safety-addendum). Review the [Fable 5.1 model documentation](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/partner-models/claude/fable-5-1) before enabling it.

## Billing and labels

The local dashboard estimates spend; the Google Cloud Billing account remains the source of truth. Optional `vertexAiChat.enableUserLabel` and `vertexAiChat.enableProjectLabel` settings attach `vscode-vertex-ai-user` and `vscode-vertex-ai-project` labels to Gemini and Claude requests.

Labels are forwarded to Billing only for PayGo usage, not Provisioned Throughput. Use explicit, stable, non-sensitive values for `userLabelValue` and `projectLabelValue`; labels appear in billing exports and high-cardinality keys can be dropped. Full setup, fallback behavior, and troubleshooting are in the [Cost Attribution Labels guide](https://github.com/jorsm/vertex-ai-models-chat-provider/wiki/Cost-Attribution-Labels), along with Google's [request-label documentation](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/capabilities/add-labels-to-api-calls) and [BigQuery billing-export documentation](https://docs.cloud.google.com/billing/docs/how-to/export-data-bigquery).

## More documentation

| Topic | Where to go |
| :-- | :-- |
| Authentication and workspace settings | [Setup & Configuration](https://github.com/jorsm/vertex-ai-models-chat-provider/wiki/Setup-&-Configuration) · [Service Account Authentication](https://github.com/jorsm/vertex-ai-models-chat-provider/wiki/Service-Account-Authentication) |
| Usage, dashboard, and BigQuery reporting | [Usage & Billing](https://github.com/jorsm/vertex-ai-models-chat-provider/wiki/Usage-&-Billing) · [Advanced Billing Reports](https://github.com/jorsm/vertex-ai-models-chat-provider/wiki/Advanced-Billing-Reports) |
| Custom model catalogs and discovery | [Model Discovery & Project Switching](https://github.com/jorsm/vertex-ai-models-chat-provider/wiki/Model-Discovery-&-Project-Switching) |
| Diagnostics | [Diagnostics & Troubleshooting](https://github.com/jorsm/vertex-ai-models-chat-provider/wiki/Diagnostics-&-Troubleshooting) |
| Architecture and provider behavior | [Architecture](docs/architecture.md) · [Providers](docs/providers.md) · [Usage & Billing internals](docs/usage-and-billing.md) |
| Current Google Cloud pricing | [Agent Platform generative AI pricing](https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing) |

## License

[MIT](LICENSE)
