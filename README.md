# Google Agent Platform for Copilot Chat

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![VS Code](https://img.shields.io/badge/VS%20Code-1.110.0%2B-blue)](https://code.visualstudio.com/)

## Native Gemini, Claude, and Grok models in VS Code Copilot Chat

Use Google Gemini, Anthropic Claude, and xAI Grok directly in the standard VS Code Chat panel. With direct Vertex access, the extension authenticates with Google Cloud and bills the project you select. Organizations can route Gemini and Claude through an enterprise proxy to centralize metrics, access policies, and business logic.

<p align="center">
  <img src="images/demo.gif" alt="Google Agent Platform for Copilot Chat demo" width="800">
</p>

- **🔒 No API keys** — Authenticate with Google Application Default Credentials or a Service Account stored in VS Code `SecretStorage`.
- **🏢 Project-aware billing** — Use workspace settings to bill the right Google Cloud project as you switch contexts.
- **⚡ Native integration** — Select models and use them alongside other providers in Copilot Chat.
- **📊 Cost visibility** — See local usage estimates and optionally attribute Gemini and Claude PayGo spend with request labels.

## ☁️ Google Cloud prerequisites

### Enterprise proxy with `proxyUrl`

For enterprise metrics or precise controls over model usage, set `vertexAiChat.proxyUrl` to your organization's HTTP gateway. Gemini and Claude calls, including tool continuations and AI commit generation, pass through that service. Implement your business logic there: caller authorization, approved models, quotas, auditing, cost attribution, and centralized usage metrics. The proxy chooses the upstream Google Cloud project and regions and invokes Vertex with its own credentials.

The [core access model](docs/proxy.md#core-access-model-users-invoke-the-proxy-the-proxy-invokes-vertex) makes the proxy the required entry point: grant users only permission to invoke the service, remove their Agent Platform User (`roles/aiplatform.user`) role and any equivalent direct Vertex access, and grant the required Vertex permissions to the proxy application's Google runtime identity. That identity calls Vertex on the authenticated user's behalf after applying your policies. `proxyUrl` configures routing; your IAM configuration prevents bypassing the proxy.

Typical [proxy use cases](docs/proxy.md#example-use-cases) include:

- Require user and/or project labels and reject calls when required attribution is missing.
- Prevent forged user attribution by deriving the caller from the verified Google account email rather than a client label.
- Block expensive, old, or deprecated models, or restrict them to authorized teams.
- Collect real-time usage and estimated costs as requests complete, while billing data is still pending.
- Analyze request counts, model adoption, input/output/cache tokens, latency, and errors.
- Route requests by project label to a client's GCP project and linked billing account, keeping one proxy URL and login for users across multiple clients.
- Enforce separate budgets for authenticated users and authorized projects.

These policies are implemented by your proxy. Sign in with your personal account using `gcloud auth login` in the extension-host environment, configure the URL in **User Settings**, clear any `vertexAiChat.projectId` setting, and run **Google Agent Platform: Refresh Models**:

```json
{
  "vertexAiChat.proxyUrl": "https://ai-proxy.example.com",
  "vertexAiChat.projectId": ""
}
```

The server supplies the entire approved catalog, including variants, capabilities, token limits, and estimated prices. Local catalogs are ignored; discovery performs no inference probes. `proxyUrl` and `projectId` are mutually exclusive, and proxy failures never fall back to direct Vertex. Grok is available only in direct mode. Leave `proxyUrl` empty to use the direct setup below.

See [Enterprise proxy: setup and implementation contract](docs/proxy.md) for authentication compatibility, required endpoints, JSON/SSE formats, labels, errors, and server responsibilities, and [Verify proxy compatibility](docs/proxy-compatibility.md) for integration checks. Proxy policy and metrics are implemented by your service; the setting supplies the transport.

### Direct Vertex access

Before you start, make sure the target Google Cloud project is ready:

1. **Enable the API:** Enable the Agent Platform API (`aiplatform.googleapis.com`). See the [Google Agent Platform documentation](https://docs.cloud.google.com/gemini-enterprise-agent-platform).
2. **Grant access:** Your identity needs the [Agent Platform User role (`roles/aiplatform.user`)](https://docs.cloud.google.com/iam/docs/roles-permissions/aiplatform#aiplatform.user).
3. **Enable partner models:** Enable any Claude models you plan to use in [Model Garden](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/partner-models/claude).

> [!TIP]
> **Pro tip:** Set a [monthly Agent Platform spend cap](https://docs.cloud.google.com/billing/docs/how-to/budgets-spend-caps) to receive alerts at 50% and 80% and pause new usage at the limit. Enforcement isn't instant, so some overage is still possible.

## 🚀 Quick start

The following steps configure direct Vertex access. For an organization-managed gateway, follow the [enterprise proxy setup](docs/proxy.md#configure-the-extension).

1. **Install** **Google Agent Platform for Copilot Chat** from the VS Code Marketplace.
2. **Authenticate** in the environment where the extension runs:

   - **Standard ADC:** run `gcloud auth application-default login` in a terminal.
   - **Service Account:** run **Google Agent Platform: Paste Service Account JSON Key** or **Google Agent Platform: Import Service Account JSON File** from the Command Palette.

3. **Set the billing and discovery project** in VS Code Settings (`Ctrl+,`):

   ```json
   {
     "vertexAiChat.projectId": "my-gcp-project-id"
   }
   ```

   Set this in workspace settings when different repositories should use different Google Cloud projects.

4. **Start chatting:** Open VS Code Chat, select a **Google Agent Platform** model, and send a prompt. If the picker is empty, run **Google Agent Platform: Refresh Models**.

For Remote SSH, Dev Containers, and Codespaces, install the extension and configure credentials in the remote workspace environment. See [Setup & Configuration](https://github.com/jorsm/vertex-ai-models-chat-provider/wiki/Setup-&-Configuration).

In direct mode, model discovery groups effort variants by their model endpoint and shares each endpoint's result across its catalog entries. It allows up to **45 seconds per endpoint in each region** by default, covering its requests and retry delays after it leaves the queue. In proxy mode, the same setting bounds the authenticated discovery request rather than individual model probes. If discovery needs more time, change **Model Discovery Timeout Seconds** in VS Code Settings or set a custom value in user or workspace settings:

```json
{
  "vertexAiChat.modelDiscoveryTimeoutSeconds": 90
}
```

Run **Google Agent Platform: Refresh Models** to apply the new timeout. Discovery runs at most **three endpoints concurrently**, spacing initial starts by 500–1,000 ms. Transient failures receive up to **three retries after the first attempt**, with randomized exponential backoff; `Retry-After` is honored within the endpoint's timeout. Endpoints that return 429 remain available with all their catalog effort variants even if retries are exhausted. Endpoints that never respond are skipped. Queue time can make the entire discovery run longer than the per-endpoint timeout.

## ✨ Key features

- **🏷️ Cost attribution labels:** Gemini and Claude PayGo calls can carry user and workspace labels. An enabled label that cannot be resolved produces a clear VS Code and output-channel warning.
- **📈 Usage dashboard and status bar:** Track local daily token usage and estimated cost in real time, then open the dashboard from the status bar for trends and detailed breakdowns.
- **🪄 AI commit messages:** Generate a Conventional Commit-style message from staged Git changes (supports custom prompt for workspace or user).
- **🧠 Gemini thinking and tools:** Supports Gemini thinking modes, thought-signature continuity, vision, and parallel tool calling where available.
- **⚡ Claude thinking and tools:** Supports signed thinking-trace continuity across tool calls, effort aliases, vision, up to 128K output tokens, and ephemeral prompt caching.
- **🔍 Smart discovery:** Probes the available Google Cloud regions and registers only the models that your selected project can access.
- **🛡️ Safe credential handling:** Stored Service Accounts are encrypted in VS Code; an explicitly selected but invalid credential fails closed instead of falling back silently.

## 🤖 Supported models

In direct mode, models are discovered for your project and region. In proxy mode, only models in the server's approved catalog appear in the picker.

| Provider  | Current catalog                                                                 | Details                                                                                                                      |
| :-------- | :------------------------------------------------------------------------------ | :--------------------------------------------------------------------------------------------------------------------------- |
| Google    | Gemini 3 Flash Preview; Gemini 3.7 and 3.8 Flash; Gemini 3.1 Pro                | [Gemini model documentation](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini)                   |
| Anthropic | Claude Fable 5.1 and 5; Opus 5.5, 5, and 4.8; Sonnet 5.5, 5, and 4.6; Haiku 4.5 | [Claude on Google Cloud](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/partner-models/claude)        |
| Grok      | Grok 4.6                                                                        | [Grok 4.6 documentation](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/partner-models/grok/grok-4-6) |

Claude Fable 5 and 5.1 require Model Garden access and are subject to Google's [Advanced AI Safety Addendum](https://cloud.google.com/terms/advanced-ai-safety-addendum). Review the [Fable 5.1 documentation](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/partner-models/claude/fable-5-1) before enabling it.

### Use your own model catalog

In direct mode, need a different model set or region order? Create a workspace `.vscode/models.json` with **Google Agent Platform: Open Workspace models.json**, or a private user catalog with **Open User Models Catalog File**. Both are seeded from the bundled catalog and receive JSON schema validation. A custom catalog fully replaces the bundled catalog, so include every model you want available. In proxy mode, configure the catalog on your server instead; local catalog files are ignored. See [Model Discovery & Project Switching](https://github.com/jorsm/vertex-ai-models-chat-provider/wiki/Model-Discovery-&-Project-Switching) for precedence, multi-root behavior, and examples.

For Claude 5 models that support adaptive thinking and the selected [effort](https://platform.claude.com/docs/en/build-with-claude/effort), append `-low`, `-medium`, `-high`, `-xhigh`, or `-max` to both the custom entry's `id` and `version`. The extension removes the suffix before calling Vertex AI, enables adaptive thinking with hidden traces, and sends the selected effort. Unsuffixed generation-5 models use each model's API default effort. For Claude Sonnet 5.5 that default is `high`; the bundled `Medium` entry follows Anthropic's recommended starting point for well-specified agentic coding and multistep tool use. Move to `high` for harder or longer work, and reserve `xhigh` or `max` for workloads where evaluations show a quality gain.

## 💳 Billing and labels

The local dashboard estimates spend; your Google Cloud Billing account remains the source of truth. Enable `vertexAiChat.enableUserLabel` and `vertexAiChat.enableProjectLabel` when you need cost attribution for Gemini and Claude PayGo requests.

Labels are not forwarded to Billing for Provisioned Throughput. Prefer explicit, stable, non-sensitive `userLabelValue` and `projectLabelValue` values: labels appear in billing exports and overly high-cardinality keys can be dropped. See the [Cost Attribution Labels guide](https://github.com/jorsm/vertex-ai-models-chat-provider/wiki/Cost-Attribution-Labels), Google's [request-label documentation](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/capabilities/add-labels-to-api-calls), and the [BigQuery billing-export guide](https://docs.cloud.google.com/billing/docs/how-to/export-data-bigquery).

## 📖 Guides and reference

| Topic                                  | Where to go                                                                                                                                                                                                                                 |
| :------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Enterprise proxy and centralized controls | [Setup and implementation contract](docs/proxy.md) · [Compatibility verification](docs/proxy-compatibility.md) |
| Authentication and workspace settings  | [Setup & Configuration](https://github.com/jorsm/vertex-ai-models-chat-provider/wiki/Setup-&-Configuration) · [Service Account Authentication](https://github.com/jorsm/vertex-ai-models-chat-provider/wiki/Service-Account-Authentication) |
| Usage dashboard and BigQuery reporting | [Usage & Billing](https://github.com/jorsm/vertex-ai-models-chat-provider/wiki/Usage-&-Billing) · [Advanced Billing Reports](https://github.com/jorsm/vertex-ai-models-chat-provider/wiki/Advanced-Billing-Reports)                         |
| Custom model catalogs and discovery    | [Model Discovery & Project Switching](https://github.com/jorsm/vertex-ai-models-chat-provider/wiki/Model-Discovery-&-Project-Switching)                                                                                                     |
| AI commit-message generation           | [AI Commit Message Generator](https://github.com/jorsm/vertex-ai-models-chat-provider/wiki/AI-Commit-Message-Generator)                                                                                                                     |
| Diagnostics                            | [Diagnostics & Troubleshooting](https://github.com/jorsm/vertex-ai-models-chat-provider/wiki/Diagnostics-&-Troubleshooting)                                                                                                                 |
| Architecture and provider behavior     | [Architecture](docs/architecture.md) · [Providers](docs/providers.md) · [Usage & Billing internals](docs/usage-and-billing.md)                                                                                                              |
| Current Google Cloud pricing           | [Agent Platform generative AI pricing](https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing)                                                                                                                     |

## License

[MIT](LICENSE)
