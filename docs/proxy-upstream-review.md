# Review of the three proxy commits — 2026-10-03

Fetched the proxy remote and reviewed `c8bc8a7`, `c3b7a49`, and `c0bf147` against our tested integration branch. Retained selected changes in local proxy commit `321ae45`; no wholesale merge, rebase, remote push, deployment, IAM change or infrastructure apply was performed.

Both proxy branches remain available in `/home/jan/Noovle/noovle-ai-companion-manager`:

- `develop`: `c0bf147`, matching `origin/develop`.
- `codex/extension-proxy-integration`: `321ae45`, extending our earlier `9f8d51e` compatibility implementation. The checkout is on this branch and clean.

The extension continues on `codex/cloud-function-proxy`. Independently created documentation commit `0156dd5` was preserved.

## Commit decisions

| Upstream commit | Worth keeping | Adaptation or omission |
|---|---|---|
| `c8bc8a7` — discovery and API documentation | `/discovery`, the complete `candidateModels` / `regionPriority` envelope, omission of models without verified metadata | Reuse our required server catalog validation, exact backend authorization and deprecation filtering. Authenticate discovery. Do not copy prefix-based matching, client-controlled destination routing, or tracked Terraform state. |
| `c3b7a49` — template-based OpenAPI and native routes | Template loading, `/openapi.json`, removal of `/predict` and shorthand inference routes | Rewrite the specification around the tested contract: server project/region, optional client user label replaced by verified email, Claude header-only attribution, Google/Anthropic vendors, 403 denial and distinct upstream-auth failures. Do not copy the generated OpenAPI file or scripts that automatically publish it to an external viewer. |
| `c0bf147` — remove bucket, synchronization scripts and bundled catalog | Keep the simpler server configuration and avoid introducing a catalog bucket/sync job for this POC | Do not adopt deletion of the only active catalog source. The final loader calls only `_load_from_local()`, but the referenced `models_catalog.json` is deleted. GCS/GitHub helpers are unused, so discovery returns an empty catalog. Our branch retains explicit `MODEL_CATALOG_JSON`; missing or invalid metadata returns a configuration error. |

## Remaining upstream incompatibilities

These were verified in the newest unmodified Docker image, not inferred solely from commit titles:

- `/discovery` returns HTTP 200 with zero models, with and without caller authentication. Deployment IAM may add an outer authentication layer; the local handler itself does not verify this endpoint.
- The extension's previous `/v1/models` discovery endpoint returns 404. The updated extension requests `/discovery`; our proxy keeps `/v1/models` as a compatibility alias for older extension builds.
- A native Gemini request carrying a project label but no client user label returns 400. This contradicts the agreed verified-email attribution policy.
- Synthetic native-route transformation retains `projects/gateway` and the client location, rather than rebuilding the route with the server project and region.
- Synthetic Claude governance injects root JSON labels and preserves the client's forged user label. Our branch retains header-only Claude labels and canonical verified-email attribution.
- Existing broad allowlist prefix matching and 400 model-denial responses remain incompatible with our exact policy and 403 contract.

The attribution differences affect behavior and cost allocation. They are part of the shared contract, not merely implementation choices: a client label must not control the billed user, and a placeholder client project must not select the upstream project.

## Executed checks

| Runtime/check | Result |
|---|---|
| Newest upstream Docker image build | Passed |
| Newest upstream's own Python suite | 30 passed, 2 failed; both failures reflect the missing catalog |
| Actual VS Code against newest upstream | Extension activated; model picker empty; expected catalog assertion failed |
| Updated integration proxy offline regressions | 63 passed |
| Updated integration proxy live HTTP, personal token and real Vertex | 18 passed, 1 skipped; Gemini high variant not configured |
| Actual VS Code 1.140.0 against updated integration proxy | All 11 recorded checks passed |
| Extension cases | 93 passed, 2 existing live Grok cases skipped |
| TypeScript, lint, bundle and diff checks | Passed |

The VS Code run covered server-only UI IDs, real Gemini/Claude SSE, tool calls and signed continuations, cancellation before and after output, and SCM generation with exactly one new usage record. Seven successful request records carried positive server-derived cost estimates. Cancellation returned in approximately 252–256 ms before output; this proves client cancellation, not cessation of upstream billing.

Both proxies ran on loopback using Docker/Functions Framework. The compatible server validated real personal Google tokens with local authentication bypass disabled and used the existing ADC file mounted read-only for upstream requests in `noovle-cloud-ai-companion`. Normal VS Code settings were untouched. Both temporary containers were stopped after testing. [Recorded results](proxy-integration-results.json) retain both the earlier run and this comparison without credentials.

## Next steps before release

1. Continue extension testing against `codex/extension-proxy-integration`; keep upstream `develop` independent until both developers agree on the tested contract and catalog configuration.
2. Adopt the complete `/discovery` contract and the retained identity, destination, policy and Claude-label fixes in any eventual combined branch. Rerun both HTTP and actual extension-host checks before merging it.
3. Validate a deployed IAM-protected function with an Invoker-only personal account and its production runtime service account. Test audience, expiry/revocation, other configured variants, Windows/remote/minimum-supported VS Code and upstream consumption after cancellation. These local checks do not establish those production behaviors.

Local reproduction remains `api/run-local-proxy.sh` in the proxy branch, followed by `scripts/run-local-proxy-vscode.sh http://127.0.0.1:18081` in the extension checkout. Stop the test proxy with `docker stop noovle-proxy-local`. Prices in the test fixture are estimates, not a verified Cloud Billing rate card.
