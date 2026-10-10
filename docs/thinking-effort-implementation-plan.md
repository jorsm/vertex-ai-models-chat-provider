# Thinking effort implementation contract

Updated 10 October 2026. This document describes the supported implementation and its acceptance criteria.

## Catalog and identity

Each catalog model has one UI `id` and a literal backend `version`. Discovery groups models by `[vendor, version]` and sends no effort settings. Selectors expose catalog entries directly. No model-name inference changes routing or effort.

Effort is optional model metadata:

```json
"effort": {
  "values": ["medium", "high", "max"],
  "default": "high"
}
```

`values` contains unique nonempty strings. `default` is required when effort is present and belongs to that list. `ModelCatalogParser` executes `schemas/models.schema.json` once when ingesting local files or proxy responses, with separate checks for ID uniqueness and default membership. The bundled catalog is validated in tests. `EffortCatalog` indexes already parsed models without validation. Backend APIs validate model support; catalog checks do not contain vendor enums or model-family patterns. A model without effort metadata sends no override. Custom catalogs replace bundled choices and remain authoritative when malformed definitions are excluded. Proxy catalogs are validated as one response and never inherit local choices.

Bundled named defaults follow current primary documentation:

- Claude Opus 5.5 and Haiku 5.5: Medium; other configured Claude effort models: High. [Claude effort](https://platform.claude.com/docs/en/build-with-claude/effort).
- Gemini 3.7/3.8 Flash: Medium; Gemini 3 Flash preview: High. [Google thinking table](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/thinking).
- Grok 4.6: High, following upstream xAI documentation. Vertex's omission default is not independently established. [Grok reasoning](https://docs.x.ai/developers/model-capabilities/text/reasoning).

## Preferences and picker

`vertexAiChat.thinkingEffortByModel` stores actual named levels keyed by model ID. Public requests resolve Workspace, then User, then the catalog default. Choosing the row marked Default saves its named value; a subsequent catalog change does not reinterpret that saved value. Removing a settings key restores inheritance. Internal commit generation uses its selected catalog model and catalog default, independently of public Chat preferences.

The command uses the Chat header brain icon and Command Palette. Model rows show the display name and effective effort. Effort rows contain exactly the values, each once, with `description: "Default"` on the default row. `activeItems` marks the effective value. Back and User/Workspace controls remain. Each selection revalidates connection/catalog revisions before its serialized, key-specific write. Cancellation writes nothing.

## Request behavior

The public callback captures preferences before waiting for labels/discovery. Catalog definitions and resolved requests are frozen snapshots. Retries retain their payload and client; destination changes cancel in-flight requests and prevent accounting against a different connection.

Adapters use the literal `spec.version` and serialize effort as follows:

| Adapter | Named effort field                                                |
| ------- | ----------------------------------------------------------------- |
| Claude  | `output_config.effort`, with adaptive thinking and hidden display |
| Gemini  | `thinkingConfig.thinkingLevel`, uppercased                        |
| Grok    | `reasoning_effort`                                                |

No explicit named value is silently replaced. Backend errors reach the caller. Claude signed/redacted thinking blocks and Gemini thought signatures remain intact on valid tool continuations. Existing cancellation, labels, pricing and transport semantics remain in force. Grok proxy transport is unsupported and fails before client creation.

## Proxy protocol

Discovery advertises `X-Vertex-AI-Catalog-Capabilities: effort-v1`; a server including effort metadata acknowledges `catalogCapabilities: ["effort-v1"]`. Basic catalogs may omit effort. Both formats use literal backend versions. Saved preferences must belong to server-advertised choices. Server-side authorization remains mandatory; client choice validation is not an enforcement boundary. Client implementation does not deploy the separate proxy application.

## Acceptance checks

- All bundled defaults belong to their model's choices and are serialized as named values.
- Default rows use gray secondary text and save the actual value at the chosen scope.
- Custom backend names reach discovery and inference literally; custom effort strings reach the native API field.
- HTTP 400 rejection is surfaced once without substituting a different level or model.
- Concurrent invocations, retries, cancellation and revision changes retain their snapshot contracts.
- Proxy catalogs remain authoritative, including restrictive choices and empty responses.
- Signed tool continuations preserve replay content while effort changes between invocations.
- Commit model selection and pricing use the catalog model directly.

See [verification](thinking-effort-verification.md) and the [desktop fixture](../test/host/README.md). Release publication and a deployed proxy's enforcement are separate checks.
