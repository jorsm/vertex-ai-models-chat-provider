# Thinking effort verification

Updated 10 October 2026 for named defaults and literal model routing. The supported catalog format is `effort: { values, default }`, where the default belongs to the named choices. The picker marks that choice with gray secondary text and saves its actual value.

## Automated coverage

| Behavior | Evidence |
| --- | --- |
| Named defaults, custom strings, literal backends, malformed definitions, duplicate IDs and frozen snapshots | [effortResolution.test.js](../test/effortResolution.test.js) |
| User/Workspace precedence, key-specific serialized writes and configuration errors | [effortConfiguration.test.js](../test/effortConfiguration.test.js) |
| Default row description, actual named-value writes, cancellation, stale catalogs and write failures | [thinkingEffortCommand.test.js](../test/thinkingEffortCommand.test.js) |
| All bundled effort payloads, independent concurrent snapshots, retries, API rejection and connection cancellation | [effortInference.test.js](../test/effortInference.test.js) |
| Literal endpoint grouping, deadlines, queue limits, 429 retry handling and discovery without effort | [discovery.test.js](../test/discovery.test.js) |
| Server authority, native serialized requests, errors and signed Claude/Gemini tool continuations | [proxy.test.js](../test/proxy.test.js) |
| Exact custom Grok backend routing, streaming, tools, reasoning/cache accounting and unsupported proxy transport | [grok46.test.js](../test/grok46.test.js) |
| Commit model scope/selection and unchanged recorded usage costs | [commitMessage.test.js](../test/commitMessage.test.js), [longContextPricing.test.js](../test/longContextPricing.test.js) |

`npm test`: **226 passed, 3 skipped, 0 failed**. Lint, bundle generation and `git diff --check` passed. `vsce ls --no-dependencies` confirmed the built extension, schema and both brain icons are packaged. The three skipped tests require opt-in live cloud configuration.

## Direct Vertex probes

During the preceding analysis, authenticated REST requests with tiny output limits produced:

| Endpoint | Input | Observed response |
| --- | --- | --- |
| Claude Sonnet 4.6 | Unknown effort string | HTTP 400 listing accepted effort names |
| Claude Sonnet 4.6 | `xhigh` | HTTP 400: model does not support that effort |
| Gemini 3.8 Flash | Unknown thinking level | HTTP 400: invalid enum value |
| Gemini 3.8 Flash | `MINIMAL` | HTTP 400: thinking level unsupported |
| Vertex Grok 4.6 | Unknown reasoning effort | HTTP 400 listing accepted REST values |
| Vertex Grok 4.6 | `low` | HTTP 200 |

Claude Haiku 5.5 attempts encountered quota or access errors and did not establish effort validation. Offline captured SDK requests confirmed the installed SDKs serialize unknown effort strings. These probes establish the sampled endpoints' rejection behavior, not every custom model's support or a deployed proxy's policy enforcement.

## Desktop and service boundaries

The [host fixture](../test/host/README.md) passed on desktop **VS Code Insiders 1.141.0**, Linux x64, using an isolated profile, including a second host run that verified User preference persistence. It checks activation, command registration, real scoped preferences, direct dispatcher callbacks and QuickPick contracts using an isolated desktop profile. Interactive Chat selection/restoration, toolbar appearance, remote hosts and language-model RPC delivery require separate checks. The companion proxy is a separate application; this extension change does not deploy or alter it.
