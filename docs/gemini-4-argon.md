# Gemini 4 Argon support

Research verified on October 13, 2026 against Google's [model specifications](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/4-argon), [developer guide](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/guides/gemini-4-argon), and [Agent Platform pricing](https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing?hl=en#gemini-4). The [September 30 announcement](https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-4-argon/) describes an earlier restricted rollout; the current model specifications list public GA on October 13.

## Catalog and API behavior

| Property        | Extension support                                                                                         |
| --------------- | --------------------------------------------------------------------------------------------------------- |
| Model ID        | `gemini-4-argon`                                                                                          |
| Locations       | Google supports `global`, `us`, and `eu`; bundled discovery tries `global` first.                         |
| Input and tools | Text, images, system instructions, and function calling through the existing Gemini provider.             |
| Thinking        | `LOW`, `MEDIUM` (default), `HIGH`, through the Thinking Effort command.                                   |
| Shared context  | 1,048,576 tokens across input, reasoning, and answer.                                                     |
| Output          | 65,536 reasoning plus answer tokens per stream. Advertised input is 983,040 to reserve that budget.       |
| Cache           | Automatic implicit caching for shared prefixes of at least 6,144 tokens. Explicit caching is unsupported. |

Google also supports audio/video understanding, structured output, grounding, and computer use. This addition uses the extension's existing text/image/tool interface; it does not add dedicated controls for those other capabilities. Cyber Permissive is a separate allowlisted model and is not bundled.

Argon rejects `thinkingBudget`, `MINIMAL` thinking, candidate count, and presence/frequency penalties. Temperature, top-p, and top-k overrides are ignored. The provider sends the supported named thinking level and its output limit. Function responses preserve API-supplied IDs, names, and the order of the preceding calls; locally generated fallback IDs remain internal when the API supplies no ID. This also applies to Gemini 3: the [3.8 Flash guide](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/guides/gemini-3-8-flash) requires ID/name/count matching, and the [general FunctionCall contract](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/rest/v1/Content#FunctionCall) requires matching IDs whenever supplied. Stream processing associates each inline thought signature with its original call, including parallel calls with identical names. Reasoning text remains hidden, while `thoughtsTokenCount` contributes to billed output alongside `candidatesTokenCount`.

## Why output stays at 65,536

Up to 1M output tokens requires multiple GenerateContent requests linked by encrypted continuation tokens. Google currently supports this only on `v1beta1`; direct non-streaming HTTP requests generate up to 32,768 tokens per segment. The latest SDK can follow continuations automatically, so a custom continuation loop is no longer essential.

The extension explicitly disables SDK automatic continuation on probes and inference. A single stream fits the existing cancellation, retry, usage, and proxy contract, whose Gemini route uses `v1`. Longer generations would require testing checkpoint recovery, aggregate usage, cancellation across requests, and server-side policy/billing. Continuation requests also bill the prompt and earlier decoded content again, generally with implicit-cache discounts. This feature is deferred; increasing a custom catalog's output limit does not enable it.

## Pricing used for estimates

The catalog uses the current Standard global promotional rates per million tokens: **$2 input, $10 reasoning/output, $0.10 cached input**, valid through **November 30, 2026**. There is no listed Argon long-context price tier. The extension does not create explicit Gemini caches.

Google delivers the promotion as **50% credits back on net spend**; the extension estimates the effective promotional cost. Starting **December 1, 2026**, the published global rates become **$4 / $20 / $0.20**, so the catalog will need updating when the promotion ends. Non-global `us`/`eu` Standard rates are 10% higher; a custom catalog can supply those rates. Cloud Billing remains authoritative, including credits, negotiated rates, and additional services.

## SDK updates and availability

- `@google/genai`: 2.6.0 → 2.29.1. This release adds automatic continuation and checkpoint handling; `automaticContinuation: false` retains the extension's existing request boundary. [Official changelog](https://github.com/googleapis/js-genai/blob/main/CHANGELOG.md).
- `@anthropic-ai/vertex-sdk`: 0.14.4 → 0.20.4. The new authentication contract requires real `Headers`, now returned by the proxy auth client. [Official changelog](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/packages/vertex-sdk/CHANGELOG.md).
- `google-auth-library`: 9.15.1 → 10.9.1, the compatible dependency generation shared by both SDK clients. [Official changelog](https://github.com/googleapis/google-cloud-node/blob/main/core/packages/google-auth-library-nodejs/CHANGELOG.md).

Direct discovery checks the selected project's access. Existing workspace/user catalogs replace the bundle and must include Argon to expose it. Proxy catalogs remain authoritative: the server must include and authorize Argon before it appears. This change does not deploy or publish either component.

Validation: clean TypeScript compilation and the full test suite passed (349 passed, three existing skips), along with lint, formatting, and the production bundle. Fixtures exercise the installed SDK's native proxy serialization, Gemini 3 and Argon tool replay, reasoning usage, and disabled checkpoint continuation. Live Vertex inference has not been verified.

## Argon visible in Language Models but missing from Copilot CLI

VS Code 1.141's Copilot CLI harness uses a shared agent host across windows. Its [BYOK registry](https://github.com/microsoft/vscode/blob/2a59476c9bfcb90b3ddc372c36762471b7dfad1c/src/vs/platform/agentHost/node/byokLmBridgeRegistry.ts#L130) takes the model list and inference connection from the first connected window with models. It assumes every window exposes the same catalog. An older installed extension or a different workspace catalog can therefore hide a newly added model from the CLI picker, even when the current window successfully discovers it and shows it in Language Models.

The observed case had nine models without Argon in the main window, ten including Argon in development windows, and nine registered BYOK models in the CLI agent host. The screenshot's unsupported-model error originated in Copilot CLI; the extension received no Argon inference request. An isolated reproduction using the installed registry confirmed that disconnecting the older window exposes the newer list.

For a development test, keep only the Extension Development Host window open and start a fresh Copilot CLI chat. For multiple windows, use the updated extension and an Argon-containing effective catalog in each window, then refresh models and start a fresh chat. The standard VS Code Agent uses the current window's model provider and is another way to test Argon. The picker workaround still needs verification in the affected user session.
