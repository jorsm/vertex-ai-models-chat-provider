# Cloud Function proxy: implementation and release plan

Status: experimental branch, not approved for release. Baseline checkpoint: `da3398a`.

## Scope and decisions

- An optional, machine-scoped `vertexAiChat.proxyUrl` selects the enterprise transport. Empty preserves direct Vertex behavior. Proxy mode never falls back to direct Vertex and requires no client GCP project or region.
- The remote runtime is a Python HTTP Cloud Function v2. Users need Cloud Run Invoker and a personal Google ID token. The initial developer POC uses the active personal `gcloud auth login` account and `gcloud auth print-identity-token`; it does not silently reuse a selected service account or switch from ADC to a different account.
- The server injects the sanitized authenticated email as the user label. Client user-label settings do not gate proxy inference. Project labels keep the existing opt-in behavior; errors returned by server policy are displayed without retries.
- Authenticated server discovery supplies the complete catalog: UI IDs, backend versions/effort aliases, variants, names, token limits, capabilities and estimated prices. The local catalog is ignored in proxy mode, including by usage accounting. No inference probes, workspace names or attribution labels are sent by discovery. Only explicitly returned variants are offered; no additional variants are inferred locally. Gemini and Claude only; Grok remains available in direct mode.
- Chat, tool continuations and commit generation use the same transport, request-label resolver, cancellation and usage accounting.

## HTTP contract proposed for the extension

The existing proxy under `/home/jan/Noovle/noovle-ai-companion-manager/api` is reference code, not an accepted contract.

`GET <proxyUrl>/discovery` returns a complete catalog using the existing `ModelSpec` shape. For example:

```json
{
  "candidateModels": [{
    "id": "company-gemini",
    "vendor": "google",
    "version": "gemini-2.5-flash",
    "displayName": "Company Gemini",
    "family": "gemini",
    "maxInputTokens": 1048576,
    "maxOutputTokens": 65536,
    "capabilities": { "imageInput": true, "toolCalling": true },
    "pricing": { "input": 0.3, "output": 2.5, "cache_read": 0.03 }
  }],
  "regionPriority": ["global"]
}
```

The example is a contract illustration, not a verified current model/price recommendation. Each entry must have a unique UI `id`; `version` is the native backend model/effort alias understood by the provider. Optional `cache_create` and `longContext` pricing follow `ModelSpec`. IDs/versions cannot contain routes or URLs. Names, positive integer token limits, boolean capabilities and finite non-negative prices are validated before publishing any model. Unsupported vendors, duplicates or incomplete entries invalidate the response.

The original `/v1/models` endpoint remains a server compatibility alias with a `models` envelope; the extension requests only `/discovery` and does not try another endpoint after errors. `regionPriority` is informational: the server controls upstream routing. An empty list means no access. No client project, region or upstream URL is supplied. Only returned variants appear; no prefix matching or local catalog expansion is used. Discovery is bounded by the configured timeout and limited to 1 MiB. Failure clears the server catalog and must not restore a local fallback. Server pricing feeds both model information and usage estimates; each request retains its selected prices even if the catalog changes before usage is recorded.

Inference preserves SDK-native Vertex routes, JSON and SSE. SDK paths use the reserved project `gateway` and location `global` as transport placeholders, not real destinations. The server MUST replace these with its own project and per-model region. Gemini uses root JSON `labels`; Claude uses base64 JSON `X-Vertex-AI-Labels`. The server MUST accept missing client user labels and replace any supplied user identity with the verified email. A denied model returns 403. Before-stream errors use the native provider envelope; upstream authentication failures must be distinguishable from caller 401 errors. No automatic gateway retries are assumed.

## Work sequence

1. Preserve existing dirty work in its own checkpoint commit; create `codex/cloud-function-proxy`.
2. Implement bounded personal token acquisition, validated endpoint configuration and authenticated discovery, with dependency-injected tests.
3. Integrate both pinned SDKs with gateway authentication and native streaming. Disable duplicate SDK retry layers in proxy mode; retry only temporary failures before output, at most twice. Link VS Code cancellation to transport abort.
4. Integrate dispatcher, activation/configuration refresh and commit generation; clear stale availability and transport/signature state on configuration or identity changes.
5. Test URL validation, auth refresh/failure, complete server catalogs/variants/pricing, no project requirement, no pings/direct calls, repository labels, SDK wire requests, SSE output before completion, usage/tool signatures, denial, partial-stream failure and cancellation.
6. Run the full existing suite, TypeScript, lint and bundle using lockfile dependencies. Review the resulting diff; do not tag, push or publish.

## Proxy compatibility status (2026-10-03)

Upstream review of `c8bc8a7`, `c3b7a49`, `c0bf147`: selectively retained `/discovery` naming/schema, native SDK route cleanup and template-based OpenAPI in proxy commit `321ae45`. Kept `develop` independent. The newest upstream suite fails two discovery cases after its catalog file was deleted; actual VS Code sees no models. Our extension now uses authenticated `/discovery`, and the adapted proxy passes 63 regression cases, 18 live HTTP cases and 11 actual extension-host checks. See [the commit review](proxy-upstream-review.md).

Pulled the clean reference `develop` branch to `e3f5f56`. The unmodified server was run in Docker: authenticated discovery returned 404, missing client user attribution returned 400, and native routes retained the dummy project. The actual VS Code extension activated successfully against it and published no models after discovery failure.

The isolated proxy branch `codex/extension-proxy-integration` adds the complete catalog endpoint, exact model authorization, canonical user attribution, native destination rewriting, Claude header-only labels, 403 policy responses and distinct upstream authentication errors. It also prevents local callers forging Cloud Run verification markers. This branch is local and not deployed.

With that branch running in Docker/Functions Framework, actual VS Code 1.140.0 passed model selection, real Gemini and Claude streaming, tool continuations, cancellation and commit generation against `noovle-cloud-ai-companion`. See [the integration report](proxy-integration-report.md) and [recorded results](proxy-integration-results.json).

## Completed local validation (2026-10-03)

- Installed dependencies from the lockfile using `npm ci --ignore-scripts --offline`; Google Gen AI 2.6.0 is the tested version.
- TypeScript compilation, ESLint, production bundle, bundle syntax/content checks and `git diff --check` passed.
- `npm test` passed all eight test files. Running each file directly exposed the individual case totals: **92 passed, 2 skipped** (the existing live Grok tests). **36 new proxy cases** passed.
- Native SDK tests exercise serialized Vertex paths, ID-token headers, Gemini JSON labels, Claude label headers, SSE output before completion, signed tool continuations, failure after partial output and cancellation during credential acquisition, discovery, backoff and streaming. Server-only models and prices work without local catalog entries; invalid/empty catalogs cannot restore local models.
- Found and corrected stale discovery reinitialization after a mode change and cancellation waiting for initial discovery. Pinned Google SDK retry options would obscure 401/403 errors, so proxy mode omits that retry layer and uses the bounded shared retry policy.

## Release gates still outstanding

- Deployed Cloud Function/Cloud Run edge invocation with authorized and unauthorized users, audience validation, token expiry/refresh/revocation and production service-account attribution. The project's Cloud Functions API is disabled; no deployment or IAM mutation was performed. Local tests used verified personal caller ID tokens and existing user ADC for upstream access, rather than a production runtime service account.
- Production-appropriate token flow. Google documents generic CLI ID tokens for development, not production.
- Other model/effort variants, minimum supported VS Code, Windows and remote extension hosts. The tested live catalog included Gemini 3.8 Flash and Claude Sonnet 5.5 with medium effort.
- Residual upstream consumption/billing after cancellation. Client cancellation and SDK transport abort are tested; immediate upstream termination and billing cessation are not established.
- Prove successful proxy inference for an Invoker-only user lacking direct Vertex IAM. The current test account has Vertex AI User and Editor.
- Review/merge the separate proxy compatibility branch before releasing the extension option.

Local Docker and actual extension-host checks passed, but do not satisfy these remaining production gates.

Official authentication references: [Cloud Functions v2 invocation](https://docs.cloud.google.com/functions/docs/securing/authenticating), [developer invocation](https://docs.cloud.google.com/run/docs/authenticating/developers), [generic development ID tokens](https://docs.cloud.google.com/docs/authentication/get-id-token).
