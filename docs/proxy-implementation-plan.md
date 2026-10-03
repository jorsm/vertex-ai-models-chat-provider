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

`GET <proxyUrl>/v1/models` returns a complete catalog using the existing `ModelSpec` shape. For example:

```json
{
  "models": [{
    "id": "company-gemini",
    "vendor": "google",
    "version": "gemini-2.5-flash",
    "displayName": "Company Gemini",
    "family": "gemini",
    "maxInputTokens": 1048576,
    "maxOutputTokens": 65536,
    "capabilities": { "imageInput": true, "toolCalling": true },
    "pricing": { "input": 0.3, "output": 2.5, "cache_read": 0.03 }
  }]
}
```

The example is a contract illustration, not a verified current model/price recommendation. Each entry must have a unique UI `id`; `version` is the native backend model/effort alias understood by the provider. Optional `cache_create` and `longContext` pricing follow `ModelSpec`. IDs/versions cannot contain routes or URLs. Names, positive integer token limits, boolean capabilities and finite non-negative prices are validated before publishing any model. Unsupported vendors, duplicates or incomplete entries invalidate the response.

An empty list means no access. No client project, region or upstream URL is supplied. Only returned variants appear; no prefix matching or local catalog expansion is used. Discovery is bounded by the configured timeout and limited to 1 MiB. Failure clears the server catalog and must not restore a local fallback. Server pricing feeds both model information and usage estimates; each request retains its selected prices even if the catalog changes before usage is recorded.

Inference preserves SDK-native Vertex routes, JSON and SSE. SDK paths use the reserved project `gateway` and location `global` as transport placeholders, not real destinations. The server MUST replace these with its own project and per-model region. Gemini uses root JSON `labels`; Claude uses base64 JSON `X-Vertex-AI-Labels`. The server MUST accept missing client user labels and replace any supplied user identity with the verified email. A denied model returns 403. Before-stream errors use the native provider envelope; upstream authentication failures must be distinguishable from caller 401 errors. No automatic gateway retries are assumed.

## Work sequence

1. Preserve existing dirty work in its own checkpoint commit; create `codex/cloud-function-proxy`.
2. Implement bounded personal token acquisition, validated endpoint configuration and authenticated discovery, with dependency-injected tests.
3. Integrate both pinned SDKs with gateway authentication and native streaming. Disable duplicate SDK retry layers in proxy mode; retry only temporary failures before output, at most twice. Link VS Code cancellation to transport abort.
4. Integrate dispatcher, activation/configuration refresh and commit generation; clear stale availability and transport/signature state on configuration or identity changes.
5. Test URL validation, auth refresh/failure, complete server catalogs/variants/pricing, no project requirement, no pings/direct calls, repository labels, SDK wire requests, SSE output before completion, usage/tool signatures, denial, partial-stream failure and cancellation.
6. Run the full existing suite, TypeScript, lint and bundle using lockfile dependencies. Review the resulting diff; do not tag, push or publish.

## Reference proxy gaps affecting compatibility

- There is currently no discovery endpoint returning the complete catalog.
- Governance requires both client labels and writes a third authenticated-user label, contrary to the agreed user-label behavior.
- Forwarding currently preserves client project/location paths rather than constructing the configured destination.
- Governance errors currently return 400 rather than the agreed model-denial 403.
- The optional EXPECTED_AUDIENCE check must be compatible with the chosen developer ID token; generic CLI tokens are not a production authentication solution.

These changes must be agreed and applied to the proxy before real integration testing. No proxy deployment or IAM mutation is part of this extension change.

## Completed local validation (2026-10-03)

- Installed dependencies from the lockfile using `npm ci --ignore-scripts --offline`; Google Gen AI 2.6.0 is the tested version.
- TypeScript compilation, ESLint, production bundle, bundle syntax/content checks and `git diff --check` passed.
- `npm test` passed all eight test files. Running each file directly exposed the individual case totals: **92 passed, 2 skipped** (the existing live Grok tests). **36 new proxy cases** passed.
- Native SDK tests exercise serialized Vertex paths, ID-token headers, Gemini JSON labels, Claude label headers, SSE output before completion, signed tool continuations, failure after partial output and cancellation during credential acquisition, discovery, backoff and streaming. Server-only models and prices work without local catalog entries; invalid/empty catalogs cannot restore local models.
- Found and corrected stale discovery reinitialization after a mode change and cancellation waiting for initial discovery. Pinned Google SDK retry options would obscure 401/403 errors, so proxy mode omits that retry layer and uses the bounded shared retry policy.

## Release gates still requiring a real environment

- Authorized/unauthorized human accounts; refresh, expiry, revocation and personal identity attribution on the actual function.
- Production-appropriate token flow and audience contract. Google documents generic CLI ID tokens for development, not production.
- Gemini and Claude streaming, signed tool continuations, cancellation before/after first output and residual upstream consumption.
- Direct Vertex denied for the user while proxy inference succeeds; no direct calls when gateway discovery or inference fails.
- Commit generation against a repository other than the active editor, one usage record, denied-model feedback.
- Actual VS Code extension-host activation and model picker; remote host account placement; no credential forwarding to workspace-selected endpoints.

Offline tests do not satisfy these live release gates.

Official authentication references: [Cloud Functions v2 invocation](https://docs.cloud.google.com/functions/docs/securing/authenticating), [developer invocation](https://docs.cloud.google.com/run/docs/authenticating/developers), [generic development ID tokens](https://docs.cloud.google.com/docs/authentication/get-id-token).
