# Verify proxy compatibility

Use this guide when implementing or changing a proxy for `vertexAiChat.proxyUrl`. The [enterprise proxy guide](proxy.md) defines the HTTP and authentication contract. Validate your own deployed configuration; a test run against another proxy does not establish your endpoint's routing, IAM, or policy behavior.

## Extension regression checks

From the extension repository, using the lockfile dependencies:

```sh
npm ci
npm test
npm run lint
npm run bundle
```

`npm test` compiles TypeScript and runs the Node test suite. [Proxy regressions](../test/proxy.test.js) exercise catalog validation, locked-SDK wire routes, authentication, labels, server pricing, streaming, tools, cancellation, and absence of direct fallback. [CLI command tests](../test/gcloudCommand.test.js) and [process tests](../test/gcloudRunner.test.js) cover launcher selection and timeout cleanup. These tests use fixtures and mocks; they do not invoke your deployed proxy or establish its upstream permissions.

## HTTP contract checks

Exercise your proxy with an authorized personal token, an unauthorized caller, missing authentication, and invalid/expired tokens. Keep tokens in memory and redact authentication headers from diagnostic output.

| Area | Verify |
| --- | --- |
| Authentication | Discovery and inference both enforce authentication and caller authorization. Client labels cannot change the verified identity. The service's token/audience policy is compatible with the current CLI token flow. |
| Discovery | `/discovery` returns complete metadata only for approved models; no-access callers get an empty catalog or the applicable authorization error. Invalid entries cannot produce a partially accepted client catalog. |
| Base path | Test a nonempty URL prefix if your deployment uses one; routes need no redirect. |
| Routing | The incoming project is the user's configured `projectId` and the location is validated against your approved regions. Verify the project allowlist: uncataloged projects and projects not permitted for the verified caller are rejected, and the destination's linked billing account matches the project. A crafted route cannot choose another hostname or an unapproved region. |
| Authorization | Direct POST requests for models absent from the caller's catalog are denied. Resolve supported aliases before enforcing exact model/effort policies. |
| Labels | Accept omitted client labels unless your documented policy requires them. Gemini uses body labels; Claude uses the base64 JSON header. Keep client attribution separate from authenticated identity. |
| SSE | First content is delivered before the response ends. Preserve native provider events, usage, signatures, tools, and finish reasons. |
| Errors | Distinguish caller `401`, policy `403`, temporary `429`/`503`, and upstream-authentication failures. Forward `Retry-After`; do not retry a permanent denial. |
| Cancellation | Disconnection closes the server's upstream stream and releases resources. Measure any residual upstream work separately. |
| Metrics | Record policy decisions, latency, model, authenticated caller, and final usage without changing the response protocol or logging tokens. |

## Actual VS Code checks

Configure a test proxy and use the normal VS Code model picker to verify:

1. A server-only UI ID absent from the bundled catalog appears with its advertised capabilities and limits.
2. Gemini and Claude stream text before completion.
3. Each model can call a tool and accept the following tool-result turn, preserving signed metadata.
4. Stop works before the first output and during an active stream.
5. AI commit generation uses an authorized model and labels from the target repository, and records successful usage once.
6. Local estimates use server prices, including cache rates; failed/cancelled requests do not create successful usage entries.
7. An empty catalog, failed discovery, policy denial, or configuration conflict exposes no direct fallback.
8. Refresh Models after an account/catalog change and reopen VS Code to verify startup acquisition and recovery in the target environment.

The repository also includes a Bash runner for an isolated extension-host session:

```sh
scripts/run-local-proxy-vscode.sh http://127.0.0.1:18081
```

Run it in an environment with Bash, `/tmp`, Node/npm, Git, the `code` command, a working Google CLI login, and a reachable compatible test proxy. It builds the extension, creates temporary user data, settings, and a Git repository, and opens a separate VS Code test window. It does not deploy or start your proxy. On Windows, use a suitable Bash environment or perform the manual checks above in native VS Code.

The [extension-host test](../scripts/test-local-proxy-extension-host.cjs) expects an approved Gemini model and an approved Claude model. It performs real inference and tool continuations, so configure the endpoint and quota for test traffic. Results and logs are generated beneath the temporary directory printed by the runner; they are run artifacts rather than checked-in documentation. The runner's settings disable the client user label and enable a fixed project label, exercising server-side authentication independently of client user attribution.

## Deployment validation

Validate the [core access model](proxy.md#core-access-model-users-invoke-the-proxy-the-proxy-invokes-vertex) using a caller permitted to invoke the proxy but lacking Agent Platform User and equivalent direct Vertex permissions. Verify both outcomes: the same user's direct Vertex inference request is denied, while an approved request through the proxy succeeds using the production runtime identity. Check group and inherited grants as well as explicitly assigned roles; removing only `roles/aiplatform.user` does not revoke permissions provided by other roles.

Exercise the actual authentication edge, configured catalog, base-path routing, and streaming gateway. Repeat startup and cancellation checks on the Windows, remote-host, and VS Code versions your organization supports. Successful local tests do not establish IAM behavior or when billing stops after cancellation.
