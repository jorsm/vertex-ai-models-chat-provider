---
id: "0002"
title: Known defects backlog
description: Unintended direct/proxy divergences and code defects found in the Step 1 analysis, to be fixed one per PR after the 0001 harness exists.
status: draft
supersedes: none
code:
    - src/VertexChatModelDispatcher.ts
    - src/providers/
    - src/ProxyGateway.ts
    - src/utils/retry.ts
    - src/models.json
---

# 0002 — Known defects backlog

## Goal

Record the defects found during the Step 1 analysis (18 Oct 2026), so a later session can fix them one at a time, each verified by the harness from spec 0001.

This spec is a backlog, not a design. Each item states the problem, the evidence and the target behavior. Before fixing an item, re-check its evidence against `develop`: line numbers are from 18 Oct and the code may have moved.

## Prerequisites

- Spec 0001 phase 1 (behavior gate, `AGENTS.md`, PR workflow) is merged.
- For B1-B5: spec 0001 phase 2 (parity suite) is merged. Each of these items should already exist as a `todo` parity test, and the fix turns it into a passing test.

## Non-goals

- Redesigning the proxy interface (stream c gets its own spec).
- Adding Grok 4.7 and reworking the Grok provider (stream b gets its own spec). B5 only records the current gap.
- Changing the declared divergences (discovery, auth) or the 30-minute retry budget.

## Items

### Unintended direct/proxy divergences

**B1. Claude retries are nested on the direct transport.**

- Evidence: the direct client keeps the Anthropic SDK's default retries (`VertexAnthropicProvider.ts:39-60`); the proxy client sets `maxRetries: 0` (`:148`). Both are wrapped in the custom `withRetry` (`:167`), whose `maxRetries` defaults to `Number.MAX_SAFE_INTEGER`, bounded only by `retryMaxDurationMinutes` (`utils/retry.ts:47-51`).
- Target: one retry layer on both transports, `withRetry` with the 30-minute budget. SDK retries are off for direct Claude calls too.
- Check: the parity scenarios "429 then success" and "500 exhausting retries" make the same number of upstream requests on both transports.

**B2. Gemini forces `apiVersion: "v1"` only through the proxy.**

- Evidence: `VertexGoogleProvider.ts:290-292`.
- Target: the same API version on both transports, chosen deliberately and stated in a comment.
- Check: a parity scenario asserts the request path on both transports.

**B3. Gemini tool-schema sanitization differs by transport.**

- Evidence: the direct transport downloads the Vertex discovery document to learn the allowed schema keys (`VertexGoogleProvider.ts:62-64`, `VertexToolSchema.ts:35-60`); the proxy transport never does and uses the static fallback list.
- Target: the same allowed-keys set on both transports, from a source that doesn't depend on which transport is active.
- Check: a parity scenario with a tool schema containing a key outside the fallback list produces the same sanitized schema on both transports.

**B4. Errors reach the user differently.**

- Evidence: the proxy transport normalizes errors into a `GatewayError` with status and policy code (`normalizeGatewayError`); the direct transport runs `checkAuthError` and throws the raw SDK error (`VertexAnthropicProvider.ts:219-228`, `VertexGoogleProvider.ts:262-268`).
- Target: one error type for both transports, with the same user-visible message for the same upstream status. Proxy-only information such as policy codes is kept as optional fields.
- Check: the parity scenarios for 403, 429 and 500 produce equal user-visible errors.

**B5. Grok rejects the proxy transport.**

- Evidence: `VertexGrokProvider.ts:215-220` throws "Grok proxy transport is not supported yet".
- Target: decided in the Grok rework spec (stream b), together with Grok 4.7. Not fixed here.

### Code defects

**B6. Silent failure swallowing.**

- Evidence: five `.catch(() => {})` sites: `VertexChatModelDispatcher.ts:63, 235, 885`, `ProxyAuth.ts:73`, `AuthManager.ts:188`.
- Target: each site either logs the failure or carries a comment explaining why ignoring it is safe.

**B7. Optional calls on required methods.**

- Evidence: `setProxyCatalog?.(` four times and `clearProxyToken?.()` once in `VertexChatModelDispatcher.ts` (`:102, 218, 220, 282, 463`). Both methods are required (`ModelCatalogResolver.ts:27`, `AuthManager.ts:155`). The optional calls exist to tolerate partial test stubs.
- Target: plain calls, with the test stubs fixed to implement the methods.

**B8. Usage-report block duplicated in every provider.**

- Evidence: `VertexAnthropicProvider.ts:196-210`, `VertexGoogleProvider.ts:237-247`, `VertexGrokProvider.ts:191-201`.
- Target: one shared helper. Do this after B1-B4, so it doesn't collide with transport fixes.

**B9. Remove Claude Haiku 4.5 from the catalog.**

- Evidence: `src/models.json`. It no longer makes sense among the current models.
- Target: entry removed, catalog tests updated, CHANGELOG entry.

### Structural follow-up

**B10. `VertexChatModelDispatcher.ts` owns too much.**

- Evidence: 936 lines, the most-changed file (63 commits). It mixes the provider registry, discovery for both transports, label resolution (~240 lines), pricing display, token counting, cancellation and inference dispatch. Configuration-change checks are repeated 10 times.
- Target: not a fix but an input to the proxy-interface spec (stream c). Start only when the parity suite exists and B1-B4 are done.

## Suggested order

| Order | Items      | Reason                                         |
| ----- | ---------- | ---------------------------------------------- |
| 1     | B9, B6, B7 | Small, independent, no transport risk          |
| 2     | B1, B4     | Retry and error behavior are what users notice |
| 3     | B2, B3     | Gemini request shape                           |
| 4     | B8         | Shared code after transports are aligned       |
| 5     | B5, B10    | Covered by the Grok and proxy-interface specs  |

## Acceptance

- [ ] Each item is closed by its own PR that links this spec and names the item.
- [ ] B1-B4 each turn a parity-suite `todo` into a passing test.
- [ ] When every item except B5 and B10 is closed, this spec moves to `implemented`, and B5 and B10 point to their successor specs.
