# Local proxy and actual VS Code integration — 2026-10-03

The unmodified latest proxy was tested first, then the agreed compatibility changes were implemented and tested in an isolated proxy branch. Nothing was deployed or published.

## Revisions and runtime

- Extension: `codex/cloud-function-proxy`, implementation `08798f7` plus the reproduction scripts in this report's commit.
- Reference proxy: clean `develop`, pulled fast-forward from `99c542d` to `e3f5f56`.
- Compatible proxy: local `codex/extension-proxy-integration`, commit `9f8d51e`, based on `e3f5f56`. The normal proxy checkout remains on `develop`.
- Docker Python 3.14.8 with Functions Framework 3.10.2; final compatible image builds and passes packaged application smoke tests.
- Actual installed VS Code 1.140.0, with the bundled extension under development and isolated user data/extensions directories.
- Vertex destination: `noovle-cloud-ai-companion`, global. Proxy listens on loopback only. Real Google caller ID tokens are validated; local auth bypass is false. The upstream identity uses the existing ADC file mounted read-only. This does not reproduce a production runtime service account.

## Results

| Check | Result |
|---|---|
| Latest unmodified proxy Python unit suite | 26 passed |
| Latest unmodified proxy authenticated discovery | 404: incompatible |
| Latest unmodified proxy missing client user label | 400: incompatible |
| Latest unmodified proxy native route | Retains `projects/gateway`: incompatible |
| Actual VS Code against unmodified proxy | Activation succeeds; discovery failure leaves model list empty |
| Compatible proxy regression suite | 53 passed |
| Compatible proxy live HTTP suite, real Vertex | 15 passed, 1 skipped (unconfigured Gemini high variant) |
| Actual VS Code against compatible proxy | All 11 recorded checks passed |
| Existing extension suite | 92 cases passed, 2 existing live Grok cases skipped |
| Compile, lint, production bundle and script syntax | Passed |

The live VS Code test used server-only UI IDs absent from the local catalog. Gemini 3.8 Flash and Claude Sonnet 5.5 returned `OK` through the public `vscode.lm` API. Each executed a tool and accepted a follow-up with its result. Cancellation before output returned in about 250 ms; cancellation after first streamed text also completed. These checks establish client cancellation, not cessation of upstream billing.

SCM generation ran against an isolated temporary Git repository, produced a conventional commit message and appended exactly one usage entry. Successful requests recorded positive estimates using server prices; cancelled requests did not add usage records. The test profile recorded seven successful request entries.

The ordinary user settings were untouched. Four documentation files in the extension checkout changed independently during testing (`architecture.md`, `features.md`, `providers.md`, `usage-and-billing.md`); those changes were preserved and excluded from the integration commits.

## Compatibility changes in the separate proxy branch

Authenticated complete catalog discovery; exact allowlist/deprecation filtering; verified email replaces missing or forged user labels; native project/location rewriting; Claude receives labels through its base64 header without invalid JSON root labels; denied models return 403. Upstream 401 is distinguished from caller authentication failures, Retry-After is preserved, and connection failures close the HTTP client.

A direct/local caller could forge the old `_REMOVED_BY_GOOGLE` marker. It now requires an actual Cloud Run runtime plus explicit operator trust of an IAM-protected edge. Token-verification exceptions no longer expose raw details. Pytest credential representations and the live runner are redacted; live tests require an explicit endpoint rather than defaulting to production.

## Reproduce

In the proxy repository, switch to the local compatibility branch and start its test profile:

```bash
git switch codex/extension-proxy-integration
api/run-local-proxy.sh
```

From the extension repository:

```bash
scripts/run-local-proxy-vscode.sh http://127.0.0.1:18081
```

This opens an actual extension-host test window, runs the live checks and writes results/logs under a fresh `/tmp/vertex-proxy-vscode.*` directory. It creates its own test Git repository and user settings. The server fixture uses estimated metadata copied from the extension catalog; those prices are not a verified Cloud Billing rate card.

After testing:

```bash
docker stop noovle-proxy-local
```

[Recorded results](proxy-integration-results.json) contain synthetic model output and checks, without credentials. Proxy branch setup details are in `api/EXTENSION_INTEGRATION.md`.

## IAM and remaining production checks

The active account has project-level Vertex AI User, Editor and Service Usage Consumer bindings. The current Editor role definition includes `run.routes.invoke`, `aiplatform.endpoints.predict` and `serviceusage.services.use`; real Vertex calls succeeded. A separate Invoker grant therefore appears unnecessary for this existing Editor account, subject to effective service policy and any IAM deny rules.

Cloud Functions API is disabled on the named project, so invocation of a deployed function was not verified. No APIs, IAM or deployed services were changed. An Invoker-only account, a production runtime service account, audience enforcement, expiry/revocation, other models/variants and Windows/remote/minimum-VS-Code hosts remain release gates. See [the updated implementation plan](proxy-implementation-plan.md).
