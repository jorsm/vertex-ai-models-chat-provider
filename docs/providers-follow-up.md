# Provider follow-up topics

This is a discussion backlog from the provider code-quality review. The accompanying refactor separates responsibilities and documents contracts while preserving existing business logic. Resolved items are marked below; remaining behaviors need a separate decision before implementation.

The observations distinguish local payload/stream fixtures from live API evidence. Reproducing a payload locally does not establish that a remote service rejects it.

## 1. Gemini signatures on parallel calls with the same name

Code: [GeminiStream.ts](../src/providers/google/GeminiStream.ts).

**Resolved with Argon support:** Inline signatures are read from each original function-call part instead of indexing by name. API call IDs are retained, and Gemini history echoes API-supplied call/response IDs and restores response order, including for Gemini 3 models. Locally generated fallback IDs stay internal when the API supplied no ID. Local stream/history fixtures cover duplicate names with separate signatures, unsigned duplicates, and multiple chunks; actual SDK proxy fixtures cover serialized replay. Live API replay remains unverified. See [Argon support](gemini-4-argon.md) and [Google's thought-signature documentation](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/thinking/thought-signatures).

## 2. Malformed streamed tool arguments

Code: [ClaudeThinking.ts](../src/providers/anthropic/ClaudeThinking.ts), [ClaudeStream.ts](../src/providers/anthropic/ClaudeStream.ts), [GrokStream.ts](../src/providers/grok/GrokStream.ts).

**Current behavior:** Claude's accumulator marks invalid JSON as unsuitable for signed replay but still returns its tool block to the stream handler. That handler can emit the tool call with its initial input. Grok logs a JSON parse failure and emits the tool call with `{}`. Local fixtures reproduced both outcomes.

**Decision:** Should an invalid tool input fail the response, suppress the call, or retain the fallback? This affects whether a tool can run with missing arguments and how much already-emitted response progress can be retained. Claude's rule for accepting signed replay is a separate concern from accepting a tool invocation.

**Validation for a future change:** Cover malformed JSON, JSON primitives, truncated streams, and valid empty objects. Decide the expected result for each before changing tests.

## 3. Gemini signature cache identity and lifetime

Code: [VertexGoogleProvider.ts](../src/providers/VertexGoogleProvider.ts), [GeminiMessages.ts](../src/providers/google/GeminiMessages.ts).

**Current behavior:** Tool signatures are keyed by the API call ID when present, with generated IDs as fallback. Text signatures are keyed by the first 120 characters of the clean answer. The signature maps and API-ID provenance set remain in memory until provider initialization clears them; conversation-window size does not evict entries. Text keys do not include model or conversation identity.

**Decision:** Choose a replay identity and eviction policy. A bounded cache limits memory but can remove signatures still needed by a continuation. Model/conversation keys reduce accidental matches but require a reliable source of conversation identity.

**Validation for a future change:** Exercise repeated prefixes, multiple conversations and models, reinitialization, and eviction while a tool continuation is pending.

## 4. Duplicate model metadata parameters

Code: [VertexModelProvider.ts](../src/providers/VertexModelProvider.ts) and the three provider entry points.

**Current behavior:** Provider requests accept both `spec` and `request.spec`. Claude and Gemini prefer `request.spec.version` for backend identity and resolved effort, but their output-budget logic still reads `spec`. Grok resolves the model specification from `request.spec`, `spec`, or the catalog. The dispatcher currently passes matching metadata, so this is an interface consistency concern rather than a demonstrated dispatcher failure.

**Decision:** Keep the compatibility parameters with an explicit precedence contract, or introduce one resolved request object and migrate callers. Decide what an adapter should do when metadata is absent or inconsistent.

## 5. SDK retries inside the shared retry policy

Code: [VertexAnthropicProvider.ts](../src/providers/VertexAnthropicProvider.ts), [VertexGoogleProvider.ts](../src/providers/VertexGoogleProvider.ts), [VertexGrokProvider.ts](../src/providers/VertexGrokProvider.ts), [retry.ts](../src/utils/retry.ts).

**Current behavior:** Direct Claude and Grok inference uses SDK retry defaults inside the extension's `withRetry` wrapper. Their installed SDKs default to two retries. Discovery overrides SDK retries; Claude proxy requests also disable them. Gemini has its own SDK-specific configuration. The refactor preserves all of these choices.

**Decision:** Choose which layer owns retry limits, delays, and cancellation. Disabling SDK retries would make the outer budget easier to reason about, but changes direct-mode behavior and requires checking error classification. Streams must not be restarted after response progress has been consumed.

**Validation for a future change:** Count actual attempts for retryable pre-stream failures and confirm cancellation interrupts both requests and delays. Keep direct mode, discovery, and proxy mode distinct.

## 6. Usage and diagnostic counter contracts

Code: [VertexModelProvider.ts](../src/providers/VertexModelProvider.ts), vendor message/stream helpers, and [UsageTrackerService.ts](../src/UsageTrackerService.ts).

**Current behavior:** Character counters use different units across vendors. Gemini counts tool-result parts and raw image bytes; Claude and Grok count tool-result text and base64 image characters. Gemini decodes non-image data into text without incrementing the corresponding text counter. Input/cache normalization and the `usage` display payload are also vendor-specific. Grok has an exact `xai/grok-4.6` branch for reasoning/output normalization. Gemini reads prompt and cached counts and sums candidate plus thinking tokens for billed output, as verified against the Argon billing contract. Other SDK usage fields remain unused.

**Decision:** Separate diagnostic measurements from billable token categories, and define each field's unit and source. Decide whether remaining Gemini usage fields belong in separate categories or diagnostics after verifying their current API/billing contracts. Avoid a generic normalization rule that changes existing Grok behavior.

**Validation for a future change:** Use captured usage fixtures for each backend, cache hits, reasoning, images, tools, and long context. Verify both tracker inputs and the VS Code display payload.

## 7. Dynamic Gemini schema discovery

Code: [VertexToolSchema.ts](../src/providers/google/VertexToolSchema.ts).

**Current behavior:** Direct initialization starts an HTTPS request for Vertex schema keys unless discovery has already succeeded. The request has no explicit timeout, response-size limit, or shared in-flight guard. Tool schema filtering uses the fallback keys until the asynchronous fetch replaces them. Initialization does not reset a successful discovery result. Proxy initialization skips starting discovery.

**Decision:** Retain dynamic discovery, use a versioned static allowlist, or cache a bounded fetch. Dynamic discovery adapts to server changes but makes the accepted tool schema depend on network timing. A static list is reproducible but needs maintenance.

**Validation for a future change:** Cover slow and repeated initialization, failed/non-200 responses, malformed documents, and requests made before and after discovery completes.

## 8. Prompt and tool content in diagnostics

Code: [ClaudeMessages.ts](../src/providers/anthropic/ClaudeMessages.ts), [GrokStream.ts](../src/providers/grok/GrokStream.ts).

**Current behavior:** Claude diagnostics include text and tool-input/result previews. Grok includes raw accumulated tool JSON when parsing fails. Routine errors can include transport-provided text. The structural refactor preserves these logs.

**Decision:** Choose whether detailed payload diagnostics require explicit opt-in, which fields can remain in normal logs, and how errors should be sanitized. This is a logging-policy decision with consequences for support and debugging.

## 9. Loose types at SDK boundaries

Code: Provider entry points and vendor message/stream helpers.

**Current behavior:** Adapters still use `any` for several request shapes and stream events. This accommodates SDK differences and current fallback behavior, but makes field mistakes harder to catch statically.

**Decision:** Introduce SDK types where they match actual payloads, or define narrow adapter-owned types with runtime validation at boundaries. A cast alone does not validate a remote event; adding validation can change how unexpected chunks are handled and belongs in a separate behavioral change.

**Validation for a future change:** Cover missing fields and unknown event/block types as well as ordinary SDK responses. Preserve explicitly selected fallback behavior.

## 10. Ownership of shared model types

Code: [VertexModelProvider.ts](../src/providers/VertexModelProvider.ts).

**Current behavior:** `ModelSpec` and `ModelCatalog` live in `VertexModelProvider.ts` but are also used by catalog parsing/resolution, effort configuration, proxy integration, and usage tracking. Their existing import paths remain stable in this refactor.

**Decision:** Keep this small shared contract file or move catalog/domain types to a dedicated module. The latter clarifies ownership but creates import churn; it does not by itself improve request behavior.

## Suggested discussion order

Start with signature replay and malformed tool arguments because they affect tool continuations. Then settle request metadata, retry ownership, and usage contracts. Cache lifetime, schema discovery, logging, and stricter types can follow once those contracts are explicit. Type placement is an independent organizational choice.
