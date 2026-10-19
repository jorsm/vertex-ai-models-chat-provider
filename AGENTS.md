# AGENTS.md

Instructions for coding agents (Claude Code first; Codex and VS Code Copilot chat supported) and for humans reviewing their work. Keep this file under 150 lines; put plans and designs in `docs/specs/`, not here.

## What this is

A VS Code extension ("Google Agent Platform for Copilot Chat") that registers one `LanguageModelChatProvider` exposing Gemini, Claude and Grok models on Vertex AI in the VS Code chat panel. It has two transports:

- **Direct:** the extension calls Vertex itself, authenticated with ADC or a service account (a key stored in `SecretStorage` or a key file path).
- **Proxy:** when `vertexAiChat.proxyUrl` is set, Gemini and Claude requests go through an enterprise proxy that centralizes and enforces policy (which models each person may use, metrics, business rules). The proxy server is not in this repo.

## Before you change anything

1. Read `docs/specs/index.md`. Open every spec whose `code` paths include files you will touch, and follow it.
2. If the change needs a spec and none covers it (see spec 0001, D1), write the spec first, from `docs/specs/_template.md`.
3. Branch from `develop`. One concern per branch and PR.

Don't create new Markdown outside `docs/specs/`, `.claude/skills/`, `AGENTS.md`, `README.md` and `CHANGELOG.md`. Files under `docs/` outside `docs/specs/` are outdated and will be deleted (spec 0001 D5): don't rely on them; the code and the specs are the reference.

## Map

- `src/extension.ts` — activation, command registration, wiring of the services below
- `src/VertexChatModelDispatcher.ts` — the `LanguageModelChatProvider`: discovery for both transports, label resolution, request dispatch to vendor providers, usage recording. Keep changes here small and focused
- `src/providers/Vertex{Google,Anthropic,Grok}Provider.ts` — one provider per vendor: client setup per transport (Grok: `src/providers/grok/GrokTransport.ts`), request building, retries, error handling
- `src/providers/{google,anthropic,grok}/` — vendor message mapping, stream parsing, tool schemas; Claude thinking and signature replay in `src/providers/anthropic/ClaudeThinking.ts`
- `src/providers/VertexModelProvider.ts` — the interface every vendor provider implements
- `src/ProxyGateway.ts`, `src/auth/ProxyAuth.ts` — proxy transport: URL validation, catalog discovery, gcloud ID-token auth, gateway error normalization
- `src/auth/` — auth method selection, ADC and service-account credentials, gcloud login helpers
- `src/ModelCatalogResolver.ts`, `src/ModelCatalogParser.ts`, `src/models.json`, `schemas/models.schema.json` — model catalog: bundled models, user/workspace overrides, schema
- `src/effort/` — thinking-effort settings, picker and resolution per model
- `src/utils/` — shared helpers: `retry.ts` (`withRetry` and the shared retry policy, bounded by `vertexAiChat.retryMaxDurationMinutes`, default 30), discovery probing, cancellation, the gcloud runner, `Logger`, token estimation
- `src/UsageTrackerService.ts`, `src/CostStatusBar.ts`, `src/DashboardWebview.ts`, `media/` — local usage and cost tracking, status bar, dashboard webview
- `src/commitMessage/` — SCM commit-message generation
- `test/*.test.js`, `test/fixtures/` — Node test runner suites and their catalog fixtures; suites import compiled `out/*.js` and stub `vscode`
- `test/host/` — fixtures that run inside a real extension host (see its README)
- `scripts/` — manual tools, including a local proxy extension-host test

## Commands

| Command | Does |
| --- | --- |
| `npm ci` | Install locked dependencies |
| `npm run compile` | Type-check and emit `out/` with `tsc` |
| `npm test` | Compile, then run every `test/*.test.js` |
| `npm run compile && node --test test/proxy.test.js` | Run one test file |
| `npm run lint` | ESLint on `src/` (zero warnings allowed) |
| `npm run format:check` / `npm run format` | Prettier check / fix |
| `npm run check` | Format check, lint and tests; the Husky pre-push hook runs this |
| `npm run bundle` | Production bundle in `out/extension.js` (esbuild) |
| `npx @vscode/vsce package --no-dependencies` | Build a `.vsix` locally (`vsce` is fetched on first use; it is not a dependency) |

Run `npm run check` before you say a change is done, and report which commands you ran and their results. A skipped or failing check is not a pass.

## Direct and proxy: declared divergences

The two transports may differ **only** in these ways:

| Behavior | Direct | Proxy | Why |
| --- | --- | --- | --- |
| Model discovery | Bundled/override catalog plus one-token probes per model and region | Catalog returned by the proxy | The proxy decides which models each person may use |
| Auth | ADC or service account | gcloud ID token sent to the proxy | Intended for now; changing it needs a spec |

Everything else (request shape, retries, tool-schema handling, streaming, usage, cancellation, user-visible errors) must behave the same on both transports. Known unintended differences are tracked in spec 0002; don't add new ones. Grok rejecting the proxy is a known gap (spec 0002 B5), not a design.

A change to transport, retry, auth or error behavior must either work the same on both transports, with tests for both, or add a row to this table through an approved spec.

## Invariants

- `vertexAiChat.projectId` is the only source of truth for the billed project. Never fall back to the project in a service account or ADC credential (see the design comment in `VertexChatModelDispatcher` discovery).
- Billing labels are sent on both transports: Gemini in the request body (`labels`), Claude in the base64 `X-Vertex-AI-Labels` header. Grok sends none today. Don't remove either.
- A configuration change while a request or discovery is in flight must fail that operation ("Configuration changed…"), never complete it against stale configuration.
- Inference retries go through `withRetry` in `src/utils/retry.ts`. Don't add a second layer (SDK retries, ad-hoc loops) on top of it. Direct Claude and direct Grok currently violate this (spec 0002 B1). Discovery probing (`src/utils/discovery.ts`) and gcloud command timeouts (`src/auth/AuthCredentials.ts`) have their own bounded policies. Changing any retry policy needs a spec.
- Logs carry metadata (roles, counts, sizes, statuses, ids), never prompt or output text, tool arguments, user identity, credentials or tokens. Existing code violates this (Claude text previews, Grok tool arguments, label values; spec 0002 B11). Don't add new cases.

## Writing tests

- Test new behavior with the real vendor SDK against a fake `fetch` (the pattern in the SDK-level tests of `test/proxy.test.js`), not with recorder providers that only capture calls.
- Assert on what VS Code receives (text parts, tool calls, usage, errors) and on upstream requests made, not on positional arguments of a recorder (`calls.at(-1)[7]`).
- Don't write count assertions that break whenever the catalog changes.
- Each test names, in its title or a one-line comment, the failure it is meant to catch.
- A transport behavior change needs a test on both transports, or a declared divergence.
- Don't make production code tolerate test stubs: no optional calls (`?.(`) on methods a type declares as required. Fix the stub instead.

## Writing code

- No `.catch(() => {})` without a comment saying why the failure is safe to ignore.
- Keep vendor-specific logic in the vendor's provider folder; don't grow `VertexChatModelDispatcher.ts` with it.
- Match the existing style; Prettier and ESLint are authoritative. `any` is allowed for SDK payloads only.

## Pull requests

- Use `.github/pull_request_template.md`. Link the spec, or say why none is needed.
- Before requesting review, run an agent review on the branch (`/code-review` and `/simplify` in Claude Code, or the equivalent in your tool). Put resulting changes in separate commits.
- Then run `/align-agents-md` (other tools: follow `.claude/skills/align-agents-md/SKILL.md`) so this file stays true for the code the PR merges.
- Branches: `spec/NNNN-slug` for spec-only PRs, otherwise `feat/…`, `fix/…`, `chore/…` or `test/…`, always cut from `develop`.
- Commits use Conventional Commits (`feat(scope): …`, `fix: …`, `docs(specs): …`); add a body when the reason isn't obvious.
- PRs target `develop`. `main` only receives release merges from `develop`. Never push to `develop` or `main` directly.
- Don't bundle unrelated changes (catalog edits, version bumps, refactors) into a PR about something else.
- A PR that changes transport, retry, auth, labels or the proxy interface updates the governing spec in the same PR.
- If you change the behavior a spec describes, update the spec in the same PR and say so in the description.
- Spec status: a spec PR sets `status: approved` once review is done (merging it is the approval); the PR that completes a spec's last deliverable sets `status: implemented`. Update the spec's row in `docs/specs/index.md` in the same PR.
