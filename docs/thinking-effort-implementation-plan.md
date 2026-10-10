# Thinking effort: implementation plan

Status: proposed implementation design; no functional implementation is included in this document.

Prepared on 8 October 2026. Companion evidence: [Thinking effort UI investigation](thinking-effort-ui-investigation.md).

9 October 2026 decision: the user removed the legacy-model requirement. The current implementation has no legacy visibility setting or bundled alias definitions; Chat and commit selectors exclude fixed-effort variants. Named defaults share one effort row with their matching value, for example Medium (Model Default). This supersedes the compatibility/default-registration parts of the original plan below.

## 1. Intended result

Let a user select a model independently from its thinking effort. Provide a **Thinking Effort** action in the Chat view header and Command Palette, persist preferences per canonical model, and translate the resolved choice into the provider's actual request payload.

The target catalog has one definition per model. Compatibility aliases preserve existing explicit effort selections during migration. The first release uses stable APIs for the new control and settings; the native per-model configuration API is a separate experiment.

The feature is complete only when persistence, request delivery, catalog policy, model identity, and tool continuations work together. Rendering a picker is one part of that result.

This plan selects concrete defaults so implementation can proceed without another design round. They are proposed product decisions, not claims that the earlier visual prototype implemented or established them.

## 2. Verified starting point

| Area | Current behavior | Consequence |
| --- | --- | --- |
| Manifest and activation | Version 0.7.4; engine and installed VS Code typings are 1.110; no effort-preview commands currently exist. | Implement the control from the current checkout. Do not assume the old preview branch contains it. |
| Catalog | The inspected bundled catalog has 31 entries representing 15 backend models. Effort variants in each group currently share pricing, token limits, and capabilities. | Consolidation is possible for this snapshot; verify these invariants again when migrating. |
| Chat registration | `VertexChatModelDispatcher.mapModels()` advertises each available catalog entry. | Separate the catalog used for routing from the model information advertised to VS Code. |
| Request dispatch | The public provider callback calls shared `infer()`, which is also used by commit-message generation. | Introduce an explicit internal request context to distinguish preference-aware requests from catalog-only requests. |
| Model selection | A header command has no stable getter for the active Copilot Chat model. | The effort command asks which model to configure. Last configured and currently selected are different concepts. |
| Claude and Google routing | Both resolve `spec.version` before building requests. | Keep UI identity separate from the backend ID. |
| Grok routing | Inference currently resolves the passed UI `modelId`; it accepts low/medium/high aliases and blocks proxy transport. | Normalize Grok using the catalog version as part of this work, with route-specific tests. |
| Catalog sources | Workspace replaces User, which replaces Bundled. Proxy mode makes even an empty server catalog authoritative. | Do not enrich a proxy/custom catalog with bundled model permissions. |
| Proxy parsing | `parseProxyCatalog()` reconstructs models from an explicit field list. | New effort and alias metadata must be validated and copied deliberately. |
| Usage | JSONL entries contain a model ID, tokens, and cost; request pricing is already passed to the tracker. | Add optional effort metadata without rewriting historical entries. |

Relevant existing files: [manifest](../package.json), [dispatcher](../src/VertexChatModelDispatcher.ts), [catalog resolver](../src/ModelCatalogResolver.ts), [provider interface](../src/providers/VertexModelProvider.ts), [proxy](../src/ProxyGateway.ts), [catalog schema](../schemas/models.schema.json), [usage tracker](../src/UsageTrackerService.ts).

The inspected working tree already contains unrelated changes in `CHANGELOG.md`, `package.json`, `package-lock.json`, `src/models.json`, and `test/discovery.test.js`, as well as the investigation document. Index status can change during concurrent work. Record the current diff before implementation and preserve those changes; do not restore or regenerate them wholesale.

## 3. Product decisions

| Decision | Initial implementation |
| --- | --- |
| Entry points | Chat header gear through `view/title`; Command Palette command using the same handler. |
| Command | `vertexAiChat.configureThinkingEffort`; title/short title `Thinking Effort`; category `Google Agent Platform`; icon `$(settings-gear)`. The category supplies the Command Palette prefix. |
| Header condition | Start with the previously verified `view == workbench.panel.chat.view.copilot`; verify on the supported host matrix. |
| Model association | Explicit model-selection step. Remember the last configured canonical ID only as a picker convenience. |
| Preference | `vertexAiChat.thinkingEffortByModel`, an object keyed by canonical catalog ID. |
| Settings scope | `window`; default writes target User settings. Preserve an existing Workspace override for the selected model. Never use the active editor URI to resolve effort. |
| Default action | `Use catalog default`, stored as the sentinel `catalog-default`. This can resolve to a named effort or to omission of effort parameters. |
| Request boundary | Apply preferences to public `provideLanguageModelChatResponse()` invocations. This includes programmatic callers through VS Code's language-model API. |
| Internal consumers | Existing calls to `infer()` use catalog/legacy behavior unless explicitly given a preference snapshot. Commit generation does not inherit the new saved effort preference. |
| Change timing | New settings affect the next provider invocation. An invocation and all of its retries keep the same snapshot. This is not session-level persistence. |
| Invalid selection | Fail with a model-specific explanation before an inference request. Never silently clamp effort or choose another model. |
| Current-value visibility | Picker rows plus model `detail`/`tooltip`, refreshed through the existing model-information event. |
| Catalog rollout | Preserve the efforts already offered by the current catalog. Add further supported levels as separate catalog decisions. |
| Alias compatibility | Explicit legacy aliases pin their effort. They never inherit a preference saved for their canonical model. |

Do not describe the setting as exclusively affecting Copilot Chat: the stable provider callback cannot distinguish all Chat and third-party API callers. The proposed `requestInitiator` field is not a dependency for this feature.

For the initial release, arbitrary `options.modelOptions` entries do not become a new effort-override API. Preserve existing options and tool behavior. A documented programmatic override can be added later with its own validation and precedence contract.

## 4. User interaction and persistence

### 4.1 Picker flow

1. Obtain the current discovered catalog snapshot. Reuse completed discovery; do not trigger fresh network probes each time the gear opens. If initial discovery is still needed, show cancellable progress using the existing bounded discovery behavior.
2. Show canonical models that have configurable effort metadata. Include vendor, effective effort, and preference source in each item's description/detail. Models without supported metadata may be listed as unavailable to configure with an explanation, but must not offer fabricated choices.
3. Preselect the last configured model if it is still in the effective catalog. Label it as last configured, not active in Chat. If there is only one configurable model, the model step may be skipped while keeping its name in the effort picker title.
4. Show `Use catalog default` followed by the catalog's permitted named values. For a named catalog default, show its value, for example `Use catalog default — High`.
5. Use `createQuickPick()` so the effective choice can be marked and initially active without pretending that a single-select `showQuickPick()` supports arbitrary preselection.
6. Display the target scope in the title or placeholder, for example `Thinking Effort — Claude Opus 5.5 — User`. Provide a clearly labeled User/Workspace scope button; disable Workspace when no workspace is open.
7. On acceptance, revalidate the selected model, permitted effort, catalog source, and connection revision. If they changed while the picker was open, refresh the choices and explain why; do not write a stale selection.
8. Write only the selected model's setting at the chosen target. After a successful write, update the last-configured convenience value and close the picker. Cancellation at any earlier point writes nothing.

Use ordinary QuickPick text and descriptions. No webview, status-bar item, command-title mutation, or workbench HTML access is needed.

Store the last configured ID in `context.workspaceState` under a dedicated key such as `thinkingEffort.lastConfiguredModelId`. It is optional convenience state, not an effort preference or evidence about the active Chat model. A missing/stale ID simply removes that convenience selection.

### 4.2 Settings representation

Proposed manifest setting:

```json
"vertexAiChat.thinkingEffortByModel": {
  "type": "object",
  "scope": "window",
  "default": {},
  "additionalProperties": {
    "type": "string",
    "enum": ["catalog-default", "minimal", "low", "medium", "high", "xhigh", "max"]
  },
  "description": "Thinking effort for public language-model requests, by canonical model ID. Available values depend on the current catalog and backend. Internal commit-message generation keeps its configured model behavior."
}
```

The schema's union is a validation vocabulary, not a promise that each model supports every value. The resolver validates against that model's advertised capabilities before any inference.

Example saved values:

```json
"vertexAiChat.thinkingEffortByModel": {
  "claude-opus-5-5": "high",
  "gemini-3.8-flash": "catalog-default"
}
```

### 4.3 Scope and write rules

- Resolve configuration without a resource URI. VS Code handles the applicable User/Remote settings layer; Workspace overrides it. Folder-specific values do not apply to this `window` setting.
- Choose the write target per model key: preserve an existing Workspace key, otherwise use User. An unrelated Workspace entry for another model must not redirect this model's write.
- Read the raw object at the selected target using `inspect()`, copy it, and update/delete only the selected key. Never write the merged effective object back into one target, which would copy inherited preferences into the wrong scope.
- Serialize writes issued by this extension. Re-read the target just before updating to preserve unrelated keys changed while a picker was open. Do not claim cross-process atomicity that the configuration API does not offer.
- Provide two distinct actions: `Use catalog default` writes `catalog-default`; `Remove override at this scope` removes the selected key and may reveal a lower-scope preference.
- An empty Workspace object does not reset every User key. A Workspace `catalog-default` value for a particular model does explicitly suppress its User preference.
- Unknown model keys remain stored so a temporary catalog/policy change does not destroy preferences. Validate only the selected request's effective key; an invalid unrelated key must not block healthy models.
- If the entire effective setting has an invalid shape, report the configuration problem. If a selected value becomes disallowed, keep it visible as invalid and offer a reset; do not silently substitute another value.
- Surface setting-write failures, including read-only workspace settings, without updating the displayed effective state as if persistence succeeded.

These preferences follow a canonical catalog ID across catalog refreshes. Every request revalidates the ID's vendor, backend version, and capability policy. A persisted choice grants no access when a different server or catalog reuses an ID.

## 5. Catalog and compatibility model

### 5.1 Additive metadata

Extend the existing interfaces with optional, typed effort metadata. Keep the backend-specific mode separate from a named effort value:

```ts
type EffortLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
type EffortPreference = EffortLevel | "catalog-default";
type CatalogEffortDefault = EffortLevel | "provider-default";

interface ModelEffortSpec {
  kind: "anthropic-adaptive" | "gemini-thinking-level" | "grok-reasoning-effort";
  values: readonly EffortLevel[];
  default: CatalogEffortDefault;
}

interface LegacyEffortAlias {
  id: string;
  displayName: string;
  version: string;
  effort: EffortLevel;
}

// Optional additions to ModelSpec:
// effort?: ModelEffortSpec;
// legacyEffortAliases?: readonly LegacyEffortAlias[];
```

`provider-default` is catalog metadata, not a user preference. It means omit the effort override and preserve the adapter's existing unsuffixed-model behavior. It never means disable thinking. A catalog that defaults to a named effort does not implicitly allow users to bypass that policy by forcing omission.

An illustrative condensed model fragment is:

```json
{
  "id": "claude-opus-5-5",
  "vendor": "anthropic",
  "version": "claude-opus-5-5",
  "effort": {
    "kind": "anthropic-adaptive",
    "values": ["high", "max"],
    "default": "provider-default"
  },
  "legacyEffortAliases": [
    {
      "id": "claude-opus-5-5-high",
      "displayName": "Claude Opus 5.5 (High)",
      "version": "claude-opus-5-5-high",
      "effort": "high"
    },
    {
      "id": "claude-opus-5-5-max",
      "displayName": "Claude Opus 5.5 (Max)",
      "version": "claude-opus-5-5-max",
      "effort": "max"
    }
  ]
}
```

The fragment omits the unchanged required name, limits, capability, and pricing fields. The restricted values intentionally preserve the current catalog offering; the provider's broader capability vocabulary does not automatically expand this list.

### 5.2 Validation

Update both editor JSON schema and runtime validation:

- Nonempty named-value arrays must contain unique values supported by the specified adapter mode; a named default must belong to that array.
- Validate `kind` against vendor/transport and known incompatible model families. Do not send `thinkingLevel` to a model that requires a token budget.
- Canonical and alias IDs must be globally unique within the effective provider catalog. Reject collisions, duplicate aliases, and ambiguous lookups.
- An alias inherits its canonical model's vendor, limits, capabilities, and pricing. Its version must resolve to the same backend endpoint, and its explicit effort must belong to the canonical policy.
- Alias metadata cannot chain to another alias or redirect to a different backend.
- Unknown effort kinds, malformed defaults, and partially invalid policies are errors; do not strip the offending field and continue with broader behavior.
- Old catalogs without the new fields remain valid and keep their exact existing alias semantics. Do not infer a configurable canonical model from an arbitrary display name or suffix.

The current local catalog resolver performs only shallow shape checks. For malformed new effort metadata in an otherwise readable custom catalog, report the affected definition and make it unavailable for inference; do not silently reinterpret it or grant the bundled model's capabilities. Preserve existing behavior for files that fail the pre-existing JSON/root-shape checks. Proxy validation continues to reject an invalid catalog as a whole, with no local fallback.

### 5.3 Bundled migration

For the currently inspected catalog:

1. Create one canonical definition for each of the 15 backend groups.
2. Retain the 13 already-existing unsuffixed canonical IDs.
3. Add unsuffixed canonical IDs for Sonnet 5.5 and Haiku 5.5. Set their catalog defaults to High and Medium respectively, preserving the behavior of the current default-looking entries.
4. Move the 18 explicit effort IDs into their canonical definition's `legacyEffortAliases`. Preserve each historical ID, version, and name; inherit pricing and limits only after equality checks pass.
5. Preserve provider-default omission for existing unsuffixed entries. Do not turn an omitted setting into explicit High merely because one model currently defaults to High.
6. Populate allowed named choices from existing catalog variants. For example, Opus 5.5 initially offers High/Max plus catalog default; Grok initially offers Low/Medium plus catalog default. Broader levels can be introduced later with route-specific evidence.
7. Keep entries without configurable effort working as normal models. Do not invent adaptive-thinking support for older Claude models that currently have no effort configuration.

Expected migration counts for this exact snapshot: 15 canonical definitions; 18 compatibility aliases; 33 advertised identities when all aliases are included because Sonnet and Haiku gain new canonical IDs. Treat these as migration assertions for the reviewed input, not permanent hardcoded catalog counts.

### 5.4 Routing versus advertised models

Build one normalized catalog index after discovery:

- Canonical definitions drive endpoint discovery and pricing.
- Exact-ID lookup resolves both canonical IDs and explicitly declared aliases.
- The Chat-information projection chooses which identities to advertise.
- Internal commit-model selection can access the complete compatibility projection even when the Chat picker is compact.

Expose a narrow dispatcher accessor such as `getEffortModelSnapshot()` returning immutable choices plus connection/catalog revisions. Keep it separate from `discoverModelsAndRegion()`, which is a refresh operation in the current implementation. Add an explicit ensure-initial-discovery path for callers that have no usable snapshot; opening the picker must not turn a cached read into a refresh.

Introduce `vertexAiChat.showLegacyEffortModels`, a `window` boolean defaulting to **true for the compatibility release**. With it enabled, advertise canonical models and aliases, marking aliases as fixed-effort legacy choices in their details while retaining historical names. With it disabled, advertise canonical definitions only for migrated models; old custom/proxy catalogs without explicit metadata retain their entries.

Compact mode satisfies the one-entry-per-model UI for migrated catalogs. Its description must explain that old Chat sessions pinned to a removed advertised alias may require model reselection; re-enabling the setting restores registration. An internal alias lookup alone cannot guarantee that VS Code restores a model it no longer knows about.

Do not use the proposed `isUserSelectable: false` field as a hidden compatibility mechanism. The existing visibility workaround in this repository is not a stable API guarantee. Changing the default to compact mode is a later release decision after restore behavior has been tested and documented.

## 6. Request resolution and provider contracts

### 6.1 Internal context

Introduce an extension-owned request context. Do not add ad hoc fields to the stable VS Code options interface or cast proposed API fields into existence.

```ts
interface EffortPreferenceSnapshot {
  readonly preferences: Readonly<Record<string, unknown>>;
  readonly sourceByModel: Readonly<Record<string, "user" | "workspace">>;
}

interface ResolvedEffort {
  readonly kind: ModelEffortSpec["kind"];
  readonly value: EffortLevel | "provider-default";
  readonly source: "user" | "workspace" | "catalog-default" | "legacy-alias";
}

interface ResolvedModelRequest {
  readonly requestedId: string;
  readonly canonicalId: string;
  readonly backendModelId: string;
  readonly effort?: ResolvedEffort;
  readonly spec: Readonly<ModelSpec>;
}
```

These are proposed contract shapes; implementation may adjust names without changing semantics. Snapshot objects must be independent copies of mutable settings/catalog data, including nested policy and pricing data. `readonly` alone is not a runtime snapshot.

Keep the existing `infer()` call sites compatible by adding an optional internal intent/context parameter after existing arguments or by introducing a shared private method with an explicit intent. Default internal intent is catalog-only. The public VS Code callback supplies a captured preference snapshot.

### 6.2 Resolution order

| Requested identity | Resolution |
| --- | --- |
| Exact declared legacy alias | Alias's pinned effort wins. Do not read the canonical model's saved preference. |
| Canonical model through public provider callback | Workspace value for that key, otherwise effective User/Remote value, otherwise catalog default. |
| Canonical model through internal catalog-only `infer()` | Catalog default. |
| Model with no effort metadata | Existing version/alias behavior. A non-default saved override for this canonical ID is unsupported and produces an explanatory error. |
| Missing ID | Existing unavailable-model error; no alternate model selection. |

`catalog-default` terminates preference lookup and resolves the catalog default; it does not fall through to User settings. An explicitly invalid higher-scope value is an error, not a reason to consult the lower scope.

For legacy standalone entries without new metadata, retain each provider's existing version-suffix semantics. New configurable definitions must have an unambiguous canonical backend version; reject conflicting explicit suffix/default declarations rather than deciding precedence by string concatenation.

### 6.3 Request lifecycle

1. At the public callback boundary, synchronously copy the relevant settings and capture the connection revision before the first asynchronous operation.
2. Await existing label resolution/discovery with cancellation. Fail if the connection destination changed; do not carry a preference-aware request into a different connection silently.
3. Resolve the exact requested ID from the current authoritative normalized catalog. Once discovery completes, capture that catalog's version/revision and copy the selected spec.
4. Resolve and validate the effective effort against the selected model's policy and the provider/transport capabilities.
5. Pass the resolved backend ID and effort as an internal typed context to the adapter. Preserve ordinary VS Code tools/options and request labels separately.
6. Build the provider payload from the snapshot once. All retries reuse it. Capture local client/gateway references or fail on the existing connection-change guard so reinitializing a provider cannot redirect an in-flight retry.
7. On successful completion, record usage with the same model, effort, and pricing snapshot.

Validate before creating an inference stream or making an inference POST. Initial discovery may itself contact the configured service before the model's capabilities are known; do not describe an invalid effort check as guaranteeing zero network activity in that situation.

One tool-result continuation is a new provider invocation. A setting change can therefore affect the next continuation. Preserve signed history and test this behavior on supported model routes. Do not promise that a global setting pins an entire agent session or silently build a session identity from the active editor.

### 6.4 Provider mapping

| Adapter | Explicit effort | Catalog `provider-default` | Required regression protection |
| --- | --- | --- | --- |
| Anthropic | `output_config.effort = value` with the existing compatible adaptive-thinking configuration. | Preserve the existing unsuffixed request behavior; do not send `thinking: disabled`. | Complete signed/redacted blocks, replay fingerprint checks, tool ordering, usage, cancellation. |
| Google | Map the normalized value to the SDK's `thinkingConfig.thinkingLevel` enum. | Omit the effort override. | Thought signatures, tool responses, generation-config merging, token counts. |
| Grok | Set `reasoning_effort` for the currently supported Vertex values. | Omit `reasoning_effort`. | Normalize `spec.version`, maintain `xai/` API path, preserve tools/streaming usage, reject proxy transport. |

Keep the legacy suffix helpers for old catalogs and aliases, but use them as compatibility decoders rather than the representation of a new selection. New code must not construct a made-up `-high` model ID to communicate effort between layers.

For Grok, normalize the backend path independently from the internal `MODEL_CONFIG` lookup key: `xai/grok-4.6` is a valid catalog version while the current lookup table uses `grok-4.6`. Preserve exact-ID membership checks in the dispatcher; normalizing a version does not authorize an arbitrary UI ID.

An SDK-supported enum is not proof that the selected Vertex route supports it. In particular, preserve the current Grok restriction on Xhigh and the existing proxy rejection until separately verified route support is implemented.

### 6.5 Refresh behavior

- Effort-setting changes refresh model details using `onDidChangeLanguageModelChatInformation`. They do not call `setProjectId()`, reset provider clients, or re-run endpoint discovery.
- Legacy-visibility changes rebuild only the advertised model-information projection.
- Connection and catalog-source changes continue to use the existing reset/discovery path. Open pickers notice these changes and revalidate before saving.
- Discovery remains grouped by provider-resolved backend endpoint. Canonical entries and aliases do not create separate probes, and selected effort is not added to discovery payloads.

## 7. Proxy compatibility and policy

### 7.1 Existing proxies

An existing server catalog without effort metadata continues to work unchanged. Keep its explicitly advertised entries and alias behavior; show that independent effort configuration is unavailable for entries that do not declare it. Do not combine a local saved preference with a guessed backend whitelist.

An empty catalog, failed discovery, or policy denial keeps the current no-direct-fallback behavior. Preferences remain stored but cannot create models or model/effort combinations absent from server policy.

### 7.2 Capability negotiation for enhanced catalogs

Condensing server aliases into metadata changes what an older extension can discover. Make the enhanced response opt-in instead of replacing the old wire catalog for every client:

1. New clients advertise `X-Vertex-AI-Catalog-Capabilities: effort-v1` on `GET /discovery` only. This is protocol metadata, not a billing/user/project label.
2. Existing servers may ignore that header and return the current catalog. The new client accepts that response as legacy mode.
3. An updated server acknowledges support with top-level `catalogCapabilities: ["effort-v1"]` and may return canonical entries containing `effort` and `legacyEffortAliases`.
4. New clients reject effort-bearing proxy entries that lack the acknowledgement, or malformed acknowledged metadata, rather than inconsistently applying only part of the policy.
5. Updated servers continue returning the previous expanded entries, IDs, versions, limits, and defaults to clients that do not advertise support. New canonical IDs need not be added to that legacy response.
6. Preserve a legacy-mode test fixture and an enhanced-mode fixture. A server which rejects the new header requires an explicit compatibility correction; the client must not retry through a direct transport.

Treat these field/header names as the contract for this implementation. Document them in `docs/proxy.md` and cover them in wire tests. The client parser can consume and normalize the acknowledgement without adding it to user-authored local catalogs.

The extension repository can implement the client and fixtures. A production proxy's support for the capability is a separate server change; this plan does not authorize modifying or deploying that external application. The feature can ship for direct mode while old proxies remain in legacy mode.

### 7.3 Policy enforcement

- The server's allowed effort set intersects with the adapter's supported controls; the UI must never expand either set.
- A server-advertised alias explicitly authorizes its inherited backend/effort combination. Do not synthesize additional aliases from a backend name.
- The proxy must enforce backend model, project, region, and effort on every inference request, including omitted effort. UI filtering is not enforcement.
- `provider-default` requires a deliberate server decision because an upstream provider can change the meaning of omission. If the server requires fixed behavior, advertise a named default and enforce it.
- Preserve native Gemini and Claude payload formats, transport authentication, label placement, signed blocks, cancellation, and error classification.
- Keep Grok through the proxy unsupported in this feature. Any future implementation needs its own route contract and verification.

## 8. Usage, diagnostics, and displayed state

Add optional fields to new usage entries, for example `canonicalModel`, `backendModel`, `effort`, and `effortSource`. Keep the existing `model` field as the requested identity so historical alias-based records remain interpretable.

When effort parameters are omitted, record `provider-default`; do not report Medium or High as an observed backend decision. The actual amount of reasoning is not determined by the selected label alone.

Continue calculating costs from the request's captured rate card and actual returned token usage. Do not invent an effort-based pricing multiplier. Do not create successful usage records for failed/cancelled requests, and preserve existing once-per-success accounting.

Update the tracker's fallback catalog lookup to resolve declared aliases through the normalized index when no request rate card is supplied. Condensing aliases must not accidentally change their fallback cost to zero. Historical JSONL records already contain recorded costs and do not need recomputation.

Update the dashboard's per-request display, if needed, to show the optional effective effort with a graceful value for historical records. Keep existing totals and model groupings compatible; rewriting old JSONL files is unnecessary.

Model details can show `Effort: High · Workspace` or `Effort: catalog default`. Refreshing metadata must preserve ID, backend version, token limits, capabilities, and pricing. A static header gear does not claim to display the active Chat model's effort.

Log a concise request-resolution entry with requested ID, canonical ID, backend ID, effort, and source. Reuse existing logging conventions; do not add credentials, signatures, prompts, or new attribution labels merely to diagnose the selector.

## 9. File changes

New paths below are proposed implementation files, not files created by this planning task.

| File | Planned responsibility |
| --- | --- |
| `src/effort/EffortTypes.ts` (new) | Preference, catalog policy, normalized identity, and resolved-request types. |
| `src/effort/EffortCatalog.ts` (new) | Validate optional metadata; build canonical/alias indexes and advertised projections. Keep VS Code UI dependencies out of this logic. |
| `src/effort/EffortConfiguration.ts` (new) | Snapshot settings; identify scope; serialize targeted updates; distinguish explicit default from removing an override. |
| `src/effort/ResolveEffort.ts` (new) | Pure resolution and validation with model-specific error details. |
| `src/effort/ConfigureThinkingEffort.ts` (new) | QuickPick lifecycle, scope control, cancellation, stale-catalog checks, and last-configured convenience state. |
| `src/providers/VertexModelProvider.ts` | Optional effort/alias metadata and typed internal request context. |
| `schemas/models.schema.json` | Describe new optional fields, enums, required members, and local validation rules. |
| `src/ModelCatalogResolver.ts` | Validate new metadata in local catalogs while preserving old-format precedence and source boundaries. |
| `src/models.json` | Consolidate reviewed bundled entries and retain explicit historical aliases. Preserve unrelated staged/unstaged catalog work. |
| `src/VertexChatModelDispatcher.ts` | Snapshot intent at the public callback, build/use normalized indexes, route exact IDs, project Chat model information, retain discovery grouping, and record resolved metadata. |
| `src/providers/ClaudeThinking.ts` | Reuse compatibility suffix parsing; expose explicit effort construction without changing signed-history handling. |
| `src/providers/VertexAnthropicProvider.ts` | Use explicit resolved context for request construction; retain compatibility when called without it. |
| `src/providers/VertexGoogleProvider.ts` | Map permitted named levels without alias synthesis; preserve the rest of generation configuration. |
| `src/providers/VertexGrokProvider.ts` | Use catalog version consistently, separate namespace/lookup keys, apply the resolved effort, and keep transport restrictions. |
| `src/ProxyGateway.ts` | Advertise/validate effort capability, preserve enhanced metadata, reject malformed policies, and retain legacy parsing. |
| `src/extension.ts` | Register the command and setting listeners; refresh metadata without re-probing endpoints. |
| `package.json` | Add command/header contribution and both settings; correct the misplaced management command separately. No new proposed-API requirement. |
| `src/commitMessage/CommitMessageModelSelection.ts` | Consume the full compatibility model projection; preserve current setting scope and selection rules. |
| `src/UsageTrackerService.ts`, `src/DashboardWebview.ts` | Add optional effective-effort reporting with old-log compatibility and unchanged cost computation. |
| `README.md`, `docs/extension.md`, `docs/architecture.md` | Describe scope, canonical identities, defaults, compact mode, compatibility limits, and provider flow. |
| `docs/proxy.md`, `docs/proxy-compatibility.md` | Document negotiation, permitted efforts, policy enforcement, and legacy/enhanced validation. |
| `test/*.test.js` | Add focused effort cases and extend existing provider, proxy, discovery, pricing, and commit regressions. |

Prefer small pure helpers over a general settings framework. No new runtime dependency or package-lock change is expected solely for this feature.

## 10. Implementation sequence

Each phase is a reviewable unit with an observable exit condition. Commit boundaries can follow these phases; publishing is not part of implementing them.

### Phase 0 — Record the baseline and freeze the intended behavior

Tasks:

1. Record branch, HEAD, dirty/staged paths, installed dependency versions, and supported host versions.
2. Capture the current catalog's exact IDs, backend resolutions, default payload behavior, pricing, limits, and capabilities in a migration fixture. Include Sonnet and Haiku's explicit defaults.
3. Confirm the header view ID on the minimum supported host and current Stable. Use an isolated profile/workspace with a fixture provider; do not replace the user's normal installed extension.
4. Run the existing test and lint baseline once before functional changes, using the repository's existing dependencies. Record pre-existing failures separately.

Exit condition: the engineer can distinguish new regressions from existing failures and can compare each migrated identity to its original behavior.

### Phase 1 — Add the typed policy, index, and pure resolver

Tasks:

1. Implement effort types, metadata validation, canonical/alias indexing, and resolution.
2. Add schema support and focused runtime validation for custom catalogs.
3. Keep old-format definitions working through the existing compatibility decoders.
4. Define typed errors for unavailable identity, invalid preference, unsupported capability, and stale selection.
5. Add table-driven tests covering precedence, explicit-default behavior, collisions, invalid metadata, and absent models.

Exit condition: a fixture model plus preference snapshot produces the expected backend ID/effort/source without requiring VS Code UI or a network service.

### Phase 2 — Connect resolved effort to requests

Tasks:

1. Add the optional internal request context to shared dispatch.
2. Snapshot saved preferences only at the public provider entry point; keep existing internal callers catalog-only.
3. Update all three adapters to accept explicit effort and backend identity while retaining their existing legacy path for callers without context.
4. Correct Grok's use of the catalog version and namespace normalization.
5. Freeze payload/transport references across retries and keep revision/cancellation guards effective.
6. Add request-capture tests asserting SDK arguments and relevant serialized wire fields.

Exit condition: changing a preference changes the intended request field; changing it during an invocation leaves that invocation/retries unchanged; legacy IDs and commit generation retain their behavior.

### Phase 3 — Implement persistence and the picker

Tasks:

1. Implement scope-aware settings reads/writes and queue extension-originated updates.
2. Implement the two-step QuickPick with back/cancel behavior, clear scope labeling, current-value marking, and explicit reset/remove actions.
3. Register header and Palette entry points with one handler.
4. Add settings listeners that refresh metadata only.
5. Handle model removal, policy change, connection change, unavailable workspace target, and failed writes while the picker is open.
6. Verify the actual gear tooltip on supported hosts; manifest title/shortTitle intent alone is not proof of host rendering.

Exit condition: the chosen model's setting persists at the intended scope, the next public request uses it, cancellation writes nothing, and opening/changing the control does not cause new discovery probes after discovery has completed.

### Phase 4 — Migrate the bundle and expose compatibility mode

Tasks:

1. Consolidate the reviewed catalog using the captured fixture, retaining all current unrelated model edits.
2. Add canonical Sonnet/Haiku IDs and preserve their explicit defaults.
3. Implement full versus compact Chat projections and the complete projection for internal commit-model selection.
4. Update catalog tests to verify semantic invariants: IDs retained through compatibility expansion, payload equivalence, shared rate cards, and discovery grouping.
5. Add user documentation describing how to opt into compact mode and recover an old session by restoring legacy registration.
6. Verify that switching effort updates detail/tooltip without changing a canonical model's ID or version.

Exit condition: compact mode advertises 15 canonical definitions for the inspected bundle; compatibility mode retains all 31 former identities plus the two new canonical IDs; exact old aliases continue producing the same payloads.

### Phase 5 — Implement enhanced proxy catalogs

Tasks:

1. Add the discovery capability header and acknowledgement handling.
2. Validate and retain canonical policy and alias metadata without importing any local defaults.
3. Extend existing wire fixtures to represent old and enhanced servers, server-only model IDs, restricted effort sets, and changed policy.
4. Document the server's obligation to enforce named and omitted effort on inference, and to retain a compatible response for old clients.
5. Verify all existing auth, labels, base-path routing, errors, cancellation, and no-direct-fallback cases remain intact.

Exit condition: old servers work as before; enhanced servers expose only their permitted options; malformed or denied policy never becomes an unrestricted local request.

External dependency: production use of independent effort through a proxy requires that server to implement the negotiated contract. Implementing the client does not establish server deployment or authorization behavior.

### Phase 6 — Finish observability, UI verification, and release documentation

Tasks:

1. Add optional usage fields and dashboard display with historical-log compatibility.
2. Correct the manifest's management-command shape in a separate change: remove the invalid nested-only configuration object and place the existing Refresh Models command at the provider's top level. Verify the legacy management action; do not make effort configuration depend on this deprecated entry point.
3. Complete the host matrix and targeted backend checks described below.
4. Run the final repository checks once after the implementation settles.
5. Update README, architecture/provider docs, proxy docs, and the changelog with exact scope and verification limits. Preserve existing changelog entries and release metadata.

Exit condition: the feature is reviewable with evidence of the full control-to-payload path and a documented compatibility strategy. A stable or prerelease Marketplace publication remains a distinct release action.

## 11. Test plan

Use the existing `node:test` style, module-level VS Code stubs, and request-capture fixtures. Add tests for observable behavior and failure boundaries; avoid a test that merely repeats a static helper's implementation.

### 11.1 Pure resolution and settings

Proposed files: `test/effortResolution.test.js`, `test/effortConfiguration.test.js`, and `test/effortCatalog.test.js`.

| Case | Expected result |
| --- | --- |
| No saved preference | Exact catalog default, including named defaults and omission. |
| User preference | Applied to canonical public-provider requests. |
| Workspace preference for same key | Wins over User. |
| Workspace preference for a different model | Does not erase or redirect the User value/write for this model. |
| Workspace `catalog-default` | Suppresses the User value and resolves the catalog default. |
| Remove Workspace override | Reveals the User value; differs from explicit catalog default. |
| Canonical request through internal `infer()` | Uses catalog default despite saved public-provider preference. |
| Declared legacy alias | Uses pinned effort regardless of canonical preferences. |
| Invalid higher-scope value | Errors; does not fall through to a lower scope. |
| Invalid unrelated key | Does not block another model. |
| Model with no metadata | Existing behavior works; an unsupported explicit override is explained. |
| Duplicate/colliding IDs, mismatched alias backend, invalid kind/default | Definition/catalog is rejected under the documented local/proxy behavior. |
| Settings mutation after snapshot | Frozen request intent is unchanged. |
| Same ID under a changed catalog policy | Revalidated; stale saved effort cannot bypass new restrictions. |
| Configuration write | Preserves unrelated keys and affects only the chosen target. |
| Read-only/failed write | Picker does not report success or change effective state. |

### 11.2 Picker behavior

Proposed file: `test/thinkingEffortCommand.test.js`.

- Available model rows come from the effective discovered catalog, not `src/models.json` directly.
- Last configured is a convenience selection and is never labeled as active Chat model.
- Effort rows exactly reflect the selected policy and show the current source/value.
- Canceling each step, using Back, closing the picker, or cancelling discovery does not persist a new choice.
- No-workspace and multi-root workspaces behave predictably; active-editor changes have no effect on effort scope.
- Scope switching, explicit default, and remove-override produce the correct targeted writes.
- A connection/catalog/policy change while the picker is open prevents a stale write.
- Repeated invocation does not leave orphaned pickers, event listeners, or pending writes.
- Opening the picker after completed discovery and accepting an effort do not initiate more availability probes.

These tests establish command behavior. They do not establish the host's real menu placement or extension-host argument marshalling.

### 11.3 Provider and dispatch behavior

Extend `test/claudeThinking.test.js`, `test/grok46.test.js`, `test/proxy.test.js`, and add `test/effortInference.test.js` where a shared dispatcher harness is clearer.

- Assert backend ID and actual effort fields for every initially advertised named value.
- Assert omission for `provider-default`, including that Claude thinking is not disabled by that option.
- Assert canonical and equivalent historical-alias requests produce equivalent model/effort fields and use the same limits/prices.
- Test a custom UI ID whose `version` is a known backend, especially the Grok `xai/` path.
- Update the old Grok unknown-UI-ID fixture deliberately: dispatcher membership remains required, while a valid supplied catalog spec controls the adapter's backend. Preserve rejection of unknown backend versions and unsupported suffixes.
- Change the setting during a deferred request/retry and prove all captured attempts retain their initial effort.
- Exercise concurrent invocations with different snapshots; there must be no shared mutable `currentEffort` on a provider.
- Reinitialize a connection during pending work and verify existing cancellation/revision semantics; no request shifts to the new destination.
- Preserve signed Claude blocks, replay fingerprint mismatches, Gemini thought signatures, tool-call matching, streaming usage, and cancellation.
- Test a tool continuation after an effort change using local payload fixtures; report route acceptance separately in live validation.
- Extend `test/commitMessage.test.js` to demonstrate that Chat preferences and compact-mode filtering do not alter an explicit commit model/alias or its existing resource-scoped selection.

### 11.4 Catalog, proxy, discovery, and accounting

- Preserve catalog fixtures before consolidation; compare compatibility-expanded identities to that fixture rather than hardcoding the new implementation's output as the expectation.
- Update `test/geminiCatalog.test.js` and existing Grok catalog cases for canonical definitions plus compatibility expansion.
- Extend `test/discovery.test.js` to prove that aliases and metadata refreshes do not multiply endpoint probes, carry effort fields, or change 429/timeout handling.
- Verify legacy discovery responses without an acknowledgement still parse and preserve their entries.
- Verify acknowledged enhanced responses preserve every policy field; invalid values, alias collisions, unknown capability versions, or unacknowledged effort metadata fail deliberately.
- Verify server-only canonical IDs, a restrictive allowed-value set, a named default, and a policy change between configuration and request.
- Verify an empty proxy catalog remains empty and local preferences/bundled metadata cannot repopulate it.
- Assert the capability header is present only where intended and does not introduce billing labels or credential leakage.
- Capture serialized Gemini/Claude payloads through the existing proxy transport fixtures, not only SDK method arguments.
- Retain Grok proxy rejection before a direct client is constructed.
- Extend accounting tests to read old JSONL records without effort fields and new records with them; use request pricing and record one successful result.

### 11.5 Real host verification

Use isolated extension-development profiles and record exact build versions, operating system, and extension-host location. An ordinary Node stub does not test these behaviors.

| Host | Required checks |
| --- | --- |
| Minimum supported desktop VS Code 1.110 | Extension loads with stable typings/contracts; header visibility or documented Palette path; picker; settings; request capture. |
| Current desktop Stable | Header gear tooltip; Palette command; User/Workspace persistence; reload; compact/full model lists; existing/new Chat sessions. |
| Remote extension host | Same command-to-provider path, configuration target behavior, cancellation, and no dependence on local source-editor state. |
| Current code-server, if supported as a release target | Header/Palette behavior and persistence; record this separately from desktop results. |
| Insiders | Regression check of the stable implementation; optional native-proposal experiment is separate. |

Start with a local fixture provider/transport to capture the effective request without cloud calls. Use it to verify:

1. Header and Palette invoke the same command successfully.
2. A saved value survives reload and appears in the appropriate model metadata.
3. A subsequent provider invocation receives the expected snapshot and payload mapping.
4. An existing session pinned to each representative legacy alias behaves as documented in compatibility mode.
5. Disabling legacy registration has the documented impact on old sessions; restoring it recovers availability without rewriting the chat database.
6. Metadata refresh preserves the currently selected canonical ID and does not reset the conversation or provider connection.
7. A narrow Chat header may place the action in overflow; the Palette path remains available.

Do not declare minimum-version compatibility from successful compilation alone. If a host lacks the intended Chat header surface, retain the Palette path and document the limitation or deliberately raise the engine floor after assessing the impact.

### 11.6 Targeted live backend verification

Run only in an appropriate test project/proxy with bounded output and a small explicit test matrix. Separate these results from local fixtures because they invoke real services and can incur usage charges.

- Verify the currently offered values on a representative Claude model and Gemini model, including default omission.
- Include one complete tool-call/result continuation with signed/thought metadata, including changing effort between provider invocations where supported.
- Confirm the Grok Vertex route still accepts only the levels this integration exposes; xAI's separate API documentation is not sufficient evidence for widening them.
- For an enhanced test proxy, exercise an allowed effort and a forbidden effort with the real authenticated edge. The forbidden request must not become a direct request.
- Check that provider defaults and explicit values are logged accurately, that cancellation is preserved, and that usage is recorded once.

If a route does not support an effort change during a pending tool exchange, resolve that before advertising the affected combination: either retain the original effort for that identifiable tool exchange with explicit reporting and tests, or defer support for that model/transition. Do not discard signed history or silently restart the conversation to make the test pass.

## 12. Verification commands and evidence

During implementation, use focused tests after each relevant change. Once all phases settle, run:

```sh
npm test
npm run lint
npm run bundle
git diff --check
```

`npm test` compiles the TypeScript modules consumed by the Node tests. Run it before bundling because the current bundle script clears `out`. If a source edit after bundling requires another test run, let `npm test` compile again. Install lockfile dependencies only when needed; do not upgrade SDKs to implement this feature.

Record evidence in a new `docs/thinking-effort-verification.md` during implementation, with columns for check, version/environment, result, and artifact/log reference. Distinguish:

- Pure/unit tests.
- Mocked SDK or serialized transport captures.
- Real VS Code UI/extension-host behavior.
- Live direct Vertex behavior.
- Live proxy routing and authorization.

Use explicit statuses such as passed, failed, not run, or blocked with a reason. Do not infer live backend success from a correctly rendered picker or an inspected payload.

## 13. Release and rollback

The compatibility release keeps legacy identities registered by default and offers compact mode explicitly. Its release notes explain scope, defaults, the new canonical Sonnet/Haiku IDs, the effect on subsequent public-provider requests, and the proxy capability requirement.

Keep model identity migration separate from unrelated model additions, pricing changes, SDK upgrades, or publishing automation. No silent conversion of `vertexAiChat.commitMessageModel`, user catalogs, VS Code chat databases, or historical usage logs is part of the release.

Rollback paths:

- Restore legacy registration to recover a session that references an old advertised ID.
- Remove a saved per-model override or choose catalog default to recover the model's previous request behavior.
- Keep alias resolution and old-catalog parsing available even if the new header action needs to be disabled on a host.
- An old proxy response remains supported by the new extension. An enhanced server retains its old-client response until its own compatibility policy changes.
- Downgrading the extension restores its bundled catalog. Any user-authored catalog containing new metadata needs its own saved copy/migration instructions; do not promise that an older extension understands it.

Changing compact mode to the default, removing legacy IDs, publishing an extension, or deploying an enhanced proxy are subsequent release decisions, not effects of writing or implementing this plan.

## 14. Optional native picker experiment

After the stable control and request resolver work, an isolated Insiders fixture can return `configurationSchema` and consume `options.modelConfiguration`. Route its validated value through the same resolver and adapter mapping so only the input mechanism changes.

Use the documented `chatProvider` proposal development setup and matching typings. Keep proposal dependencies out of the Marketplace artifact. Explicitly validate native persistence, schema-default precedence, multiple Chat editors, reload, and actual request delivery; a changed dropdown label is insufficient.

Do not automatically prefer the mere presence of a proposed field over saved settings in the stable implementation. The native experiment needs its own precedence rule because the host can include schema defaults even when a user did not make an explicit choice.

For the desired composer placement, a separate upstream fix must prevent internal circular widget objects from crossing the contributed-command RPC boundary. Removing callback parameters, adding callback-level `try/catch`, or changing icons is not a repair. An upstream patch must also account for built-in consumers before changing the toolbar's forwarding behavior.

## 15. Completion criteria

- [ ] Header and Palette provide a working effort picker on the documented supported hosts.
- [ ] Choices persist with correct per-model scope, reset, remove-override, and cancellation behavior.
- [ ] The public provider callback receives the effective preference; internal commit generation preserves its established selection behavior.
- [ ] Canonical identity is independent from request effort, with explicit compatibility for historical IDs.
- [ ] Named/default precedence and unsupported combinations are deterministic and explained to the user.
- [ ] Each adapter receives the exact intended backend identity and effort fields.
- [ ] Retry/concurrency behavior preserves each invocation's starting snapshot.
- [ ] Claude/Gemini signed continuation behavior, cancellation, and usage accounting remain correct.
- [ ] Local, custom, legacy proxy, and enhanced proxy catalogs follow their distinct authority rules.
- [ ] No extra discovery probes, new billing attribution on discovery, or direct fallback are introduced.
- [ ] Compact mode's restoration limitations are tested and documented; compatibility mode retains former identities.
- [ ] Current-value metadata and optional usage fields remain readable with historical data.
- [ ] Final compile/test, lint, bundle, and diff checks are recorded, with real-host and live-service results identified separately.

## 16. Sources and evidence boundaries

The [companion investigation](thinking-effort-ui-investigation.md) records the historical code-server toolbar reproduction and its limits. This plan does not repeat that experiment or claim a newly verified desktop failure.

The preceding research checked these sources on 8 October 2026. Recheck version-sensitive APIs and provider support when implementation begins:

- [Proposed chatProvider declarations](https://github.com/microsoft/vscode/blob/49b24202921f02dc1215eb8db80d50ae239b3da7/src/vscode-dts/vscode.proposed.chatProvider.d.ts): native schema/configuration and selectability metadata remain proposed.
- [Stable declarations at the same commit](https://github.com/microsoft/vscode/blob/49b24202921f02dc1215eb8db80d50ae239b3da7/src/vscode-dts/vscode.d.ts): model information, provider callback, stable request options, and information-change event.
- [Using proposed API](https://code.visualstudio.com/api/advanced-topics/using-proposed-api): development and distribution boundary for the optional native experiment.
- [Chat input toolbar source](https://github.com/microsoft/vscode/blob/49b24202921f02dc1215eb8db80d50ae239b3da7/src/vs/workbench/contrib/chat/browser/widget/input/chatInputPart.ts#L4145-L4153): internal widget forwarding still present in the researched source.
- [Provider contribution schema](https://github.com/microsoft/vscode/blob/49b24202921f02dc1215eb8db80d50ae239b3da7/src/vs/workbench/contrib/chat/common/languageModels.ts#L811-L863): configuration schema versus top-level deprecated management command.
- [Configuration scopes](https://code.visualstudio.com/api/references/contribution-points#scope): `window` supports User/Remote and Workspace settings without folder-based semantics.
- [Language Model Chat Provider API](https://code.visualstudio.com/api/extension-guides/ai/language-model-chat-provider): provider registration and stable model metadata.
- [VS Code issue 322280](https://github.com/microsoft/vscode/issues/322280): prior native configuration-delivery issue is closed/verified for milestone 1.126.0; that closure does not finalize the API.
- [Claude effort](https://platform.claude.com/docs/en/build-with-claude/effort): named effort is model-specific; backend capability and the extension's initial allowed set are distinct.
- [Gemini 3.8 Flash](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-8-flash): Low/Medium/High support and rejection of Minimal for this model.
- [Current Grok implementation](../src/providers/VertexGrokProvider.ts): this integration's Vertex effort and proxy restrictions, which this plan preserves.

All new schemas, helper names, settings, capability-negotiation fields, and rollout choices in this plan are proposed implementation contracts. They are not existing VS Code APIs or already deployed server features.
