---
id: "0001"
title: Repo harness
description: Specs, PR workflow, agent instructions, behavior gate, docs reset and the transport parity suite that every later change relies on.
status: draft
supersedes: none
code:
    - AGENTS.md
    - docs/specs/
    - .github/
    - .husky/
    - package.json
    - test/
---

# 0001 — Repo harness

## Goal

Make every future change to this repo **checkable**: an agent or a person can tell, before merge, whether a change kept the intended behavior, respected recorded decisions, and stayed in scope.

The harness exists to support three streams of upcoming work, none of which is part of this spec:

- **(a)** fixing the unintended differences between the direct and proxy transports (spec 0002);
- **(b)** adding Grok 4.7 and reworking the Grok provider;
- **(c)** turning the proxy into a clean interface decoupled from the client.

## Context

Evidence from the Step 1 analysis (18 Oct 2026):

- 379 tests exist (376 pass, 3 skipped) but **CI and the stable Marketplace publish never run them**. Only the pre-release workflow and a skippable local pre-push hook do.
- **No branch has ever had agent instructions.** Agents start from 8.7k lines of code and 263 KB of Markdown, much of it completed hand-off notes; topics repeat up to 8 times.
- **Direct and proxy diverge in 7 concerns**, two by design (discovery, auth) and the rest by accident. Nothing in the repo says which is which.
- **Every SDK-level test goes through the proxy.** The direct transport is never exercised offline, no test compares the two transports, and every stream fixture is hand-written.
- **Behavior changed without review.** On 14 Oct the retry policy was rewritten. Code and changelog were updated, `docs/proxy.md` was not. Two people commit to this repo; there is no branch protection.

## Non-goals

- Fixing any bug found in the analysis. Those are listed in spec 0002 and handled separately.
- The proxy server implementation.
- The existing `codex/live-adc-release-gate` branch. It will be deleted and recreated when needed.
- Refactoring `VertexChatModelDispatcher.ts` or the providers. That comes after phase 2 exists.
- Changing the retry policy, the model catalog, or the Gemini diagnostics branch.
- Converting tests to TypeScript or rewriting existing tests.

## Decisions this spec builds on

| Decision                                                                       | Consequence for the harness                                                             |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| Plans are tracked as specs in the repo                                         | `docs/specs/` is the only place for plans, designs and decisions                        |
| Work happens through PRs                                                       | Every change, including specs, reaches `develop` through a PR                           |
| Discovery differs by design (the proxy enforces which models each person sees) | Declared divergence, excluded from parity checks                                        |
| Auth differs by design for now (open to redesign)                              | Declared divergence, excluded from parity checks until a spec changes it                |
| All other direct/proxy differences are candidates to fix                       | Parity checks treat them as failures to track, not as accepted behavior                 |
| The 30-minute `withRetry` budget is the intended retry behavior                | Docs describing a 2-retry, 60-second budget are stale                                   |
| Agents in use: Codex, VS Code chat with this extension, Claude Code            | One root `AGENTS.md`, no `CLAUDE.md`, no nested `AGENTS.md`                             |
| Old docs will be trashed and restructured; the repo has a wiki                 | User-facing guides move to the wiki; the repo keeps only what agents and reviewers need |
| Specs borrow OKF conventions, not OKF compliance                               | Frontmatter + index, no OKF version field, no OKF skill                                 |

## Phase 1 — Setup

Configuration, instructions and deletion. No production code changes.

### D1. Specs system

Create:

- `docs/specs/index.md`: one line per spec (`id`, title, status, link), newest first.
- `docs/specs/_template.md` with these sections: Goal, Context, Non-goals, Decisions, Behavior and invariants, Declared divergences (only if the change touches transport), Deliverables, Acceptance checks, Open questions.

Frontmatter fields, all required:

| Field         | Meaning                                                                                 |
| ------------- | --------------------------------------------------------------------------------------- |
| `id`          | Four-digit string, never reused                                                         |
| `title`       | Short name                                                                              |
| `description` | One line; what an agent reads in the index to decide whether to open the file           |
| `status`      | `draft` → `approved` → `implemented`, or `superseded`                                   |
| `supersedes`  | Spec id or `none`                                                                       |
| `code`        | Paths the spec governs, so an agent editing a file can find the spec that constrains it |

Rules:

- A change needs a spec when it alters user-visible behavior, a provider or transport, the proxy interface, auth, the catalog format, or the harness itself. Typo fixes, dependency bumps and internal renames don't.
- A spec reaches `approved` through its own PR, merged before implementation starts. Small specs may be approved in the same PR as the implementation if the reviewer agrees.
- The implementing PR sets `status: implemented` and updates `index.md`.
- Specs are never deleted. A replaced spec gets `status: superseded`, and the new one names it in `supersedes`.
- A spec that changes during implementation is updated in the same PR, with the change called out in the PR description. An agent never silently redefines acceptance checks to match what it built.

**Acceptance:** `index.md` and `_template.md` exist. Specs 0001 and 0002 follow the template's frontmatter and are listed in the index.

### D2. `AGENTS.md`

One file at the repo root, at most 150 lines, read by Codex, VS Code chat (`chat.useAgentsMdFile`) and Claude Code. It must contain:

1. **What this is:** one paragraph on the extension and its two transports.
2. **Map:** where providers, transport, auth, catalog, effort, usage and commit-message code live; the three files that change most (`VertexChatModelDispatcher.ts`, `VertexGoogleProvider.ts`, `extension.ts`).
3. **Commands:** `npm run compile`, `npm test`, `npm run lint`, `npm run check`, `npm run bundle`, and how to run one test file.
4. **Workflow:** branch from `develop`, read `docs/specs/index.md` first and open the specs whose `code` paths you will touch, one concern per PR, follow the PR template.
5. **Declared divergences:** a table of the behaviors where direct and proxy are allowed to differ (discovery, auth) and the statement that everything else must behave the same. Grok rejecting the proxy is listed as a current known gap, not an intended design.
6. **Invariants:**
    - `vertexAiChat.projectId` is the only source of truth for billing; never fall back to a credential's project (`VertexChatModelDispatcher.ts:313-320`).
    - Billing labels are sent on both transports: Gemini in the request body, Claude in the `X-Vertex-AI-Labels` header.
    - A configuration change during a request must fail the request, not complete it against a stale configuration.
7. **Test rules:** see D6.
8. **Docs rules:** see D5.
9. **Don'ts:** no new Markdown outside `docs/specs/`, `AGENTS.md`, `README.md` and `CHANGELOG.md`; no optional calls (`?.(`) on methods a type declares as required; no `.catch(() => {})` without a comment saying why the failure is safe to ignore; don't bundle unrelated changes (e.g. catalog edits) into a harness or CI PR.

**Acceptance:** the file exists, is under 150 lines, and every path and command it names exists. A fresh agent session asked "where is Claude retry configured and which spec governs it?" can answer from `AGENTS.md` and the specs index alone.

### D3. PR workflow

- **Branches:** `spec/NNNN-slug` for spec-only PRs, `feat/…`, `fix/…`, `chore/…`, `test/…` otherwise. Always cut from `develop`.
- **Commits:** keep the existing Conventional Commits style; a body explains why when the change isn't obvious.
- **Template** `.github/pull_request_template.md` with:
    - Spec: link, or "none needed" with a one-line reason
    - What changed and why (three lines at most)
    - Checks run: which commands, with results
    - Does this touch a declared divergence or a transport? If yes, which, and how parity is checked
    - Docs: updated / not needed
    - Out of scope: anything noticed but deliberately not changed
- **Review order:** the author's agent runs `/code-review` and `/simplify` (or the equivalent in Codex) on the branch before requesting review, and puts the resulting changes in separate commits. Then a human reviews.
- **Merging:** PRs merge into `develop` only. `main` receives only release merges from `develop`.
- **Manual step for the repo owner:** in GitHub settings, protect `develop` and `main`: require a PR, one approving review, and the CI check from D4 to pass.

**Acceptance:** the template exists, and the next PR after this spec uses it. Branch protection is enabled on both branches (manual, confirmed by the owner).

### D4. Behavior gate

- `ci.yml`: add `npm test` after `npm run compile`, on pushes and PRs to `develop` and `main`.
- `publish.yml`: add `npm test` before packaging and publishing.
- Keep the Husky `pre-push` hook (`npm run check`) as the local gate.
- Claude Code only: a `Stop` hook in `.claude/settings.json` that runs `npm run check` and reports failures back to the agent before it finishes. Codex and VS Code chat rely on CI and the pre-push hook.

**Acceptance:** a PR that breaks one test fails CI. A tag push with a failing test does not publish.

### D5. Docs reset

The repo keeps only what agents and reviewers need. User-facing guides move to the wiki.

| Keep in the repo           | Notes                                                                                                                                                                                                                                     |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `README.md`                | Rendered on the Marketplace listing, so it stays user-facing: what it does, prerequisites, quick start, link to the wiki. Move internals (discovery, effort, dev tooling) out                                                             |
| `CHANGELOG.md`             | Unchanged                                                                                                                                                                                                                                 |
| `AGENTS.md`, `docs/specs/` | New                                                                                                                                                                                                                                       |
| `docs/proxy-interface.md`  | The client side of the proxy interface only (routes, request and response shapes, status codes, retry behavior), extracted from `docs/proxy.md` lines 121-353 and corrected to the current 30-minute retry behavior. Basis for stream (c) |
| `test/host/README.md`      | Accurate; keep                                                                                                                                                                                                                            |

Everything else under `docs/`, plus `TODO.MD` and `vsc-extension-quickstart.md`, is deleted from the repo. Before deleting, the owner decides which parts move to the wiki (likely: usage and billing, provider setup, thinking effort for users). Two source comments point at `docs/providers-follow-up.md` (`ClaudeStream.ts:63`, `ClaudeMessages.ts:110`); they are updated to point at spec 0002.

Docs rule for `AGENTS.md`: a PR that changes transport, retry, auth, labels or the proxy interface updates `docs/proxy-interface.md` or the governing spec in the same PR.

**Acceptance:** `docs/` contains only `specs/` and `proxy-interface.md`. No source comment links to a deleted file. The README still renders correctly on the Marketplace (check the packaged VSIX).

### D6. Test rules

Written into `AGENTS.md`; existing tests are not rewritten.

- New behavior tests use real SDKs against a fake `fetch` (the pattern in `proxy.test.js:1107-1352`), not recorder providers.
- No assertions on positional arguments of recorders (`calls.at(-1)[7]`); assert on observable output.
- No count assertions that break whenever the catalog changes (e.g. "exactly 16 probes").
- A test states the failure it is meant to catch, in its name or a one-line comment.
- A transport behavior change needs a test on both transports, or a declared divergence.

**Acceptance:** the rules are in `AGENTS.md`, and the PR template's divergence question references them.

## Phase 2 — Transport parity suite

The first piece of real build work. It turns "direct and proxy behave differently" into a list of failing or skipped tests, which spec 0002 then works through.

### D7. Parity suite

- A new test file, `test/transportParity.test.js`, that runs each scenario through both transports for Gemini and Claude. Both use the real SDK; `fetch` is replaced by one fake upstream that serves the same responses to both.
- **Scenarios:** plain chat; tool call and tool-result continuation; thinking or signed-reasoning replay; usage reporting; cancellation mid-stream; upstream 429 then success; upstream 403; upstream 500 exhausting retries; malformed stream chunk.
- **Assertions:** what VS Code receives (text parts, tool calls, usage, errors and their user-visible message), and how many upstream requests were made.
- Declared divergences (discovery, auth) are excluded. Each known unintended divergence is a test marked with `{ todo: "spec 0002 B<n>" }`, so the suite passes while the list stays visible.
- Grok joins the suite when its provider is reworked (stream b).

**Acceptance:** the suite runs in `npm test` and in CI. Every unintended divergence in the Step 1 table either passes or appears as a `todo` linked to a spec 0002 item. The direct transport is exercised at SDK level for both Gemini and Claude.

### D8. Recorded fixtures

- A script, `scripts/record-fixtures.cjs`, run manually with real credentials. It captures raw upstream responses for a small set of prompts per vendor (Gemini, Claude, Grok) on the direct transport, and saves them under `test/fixtures/recorded/` with secrets and identifiers stripped.
- The parity suite and provider tests can replay these instead of hand-written streams.

**Acceptance:** at least one recorded chat and one recorded tool-call stream per vendor are replayed by an offline test. The recording script refuses to run without an explicit project id and never writes credentials.

## Rollout

| PR     | Content                                                                                  | Depends on |
| ------ | ---------------------------------------------------------------------------------------- | ---------- |
| 1      | `spec/0001-0002`: this spec and spec 0002, plus `docs/specs/index.md` and `_template.md` | none       |
| 2      | `AGENTS.md` and the PR template (D2, D3, D6)                                             | 1          |
| 3      | Behavior gate: CI and publish run tests, optional Claude Code Stop hook (D4)             | 1          |
| 4      | Docs reset (D5), after the owner has moved chosen content to the wiki                    | 2          |
| 5      | Parity suite (D7)                                                                        | 3          |
| 6      | Recorded fixtures (D8)                                                                   | 5          |
| Manual | Branch protection on `develop` and `main`                                                | 3          |

PRs 2 and 3 can be done in parallel. Each PR uses the template from PR 2 once it exists.

## Acceptance for the whole spec

- [ ] A PR that breaks a test cannot merge into `develop` or publish to the Marketplace.
- [ ] A fresh agent session finds the map, the commands, the declared divergences and the governing specs from `AGENTS.md` alone.
- [ ] Every unintended direct/proxy divergence is visible as a passing or `todo` parity test.
- [ ] `docs/` holds only specs and the proxy interface; no topic is documented twice.
- [ ] Spec 0002 can be worked through one item per PR, each closing a `todo` in the parity suite where applicable.

## Open questions

- Which parts of the deleted docs go to the wiki, and who moves them?
- Should Nicola's approval be the required review for your PRs, and yours for his?
- Is the Claude Code `Stop` hook wanted, given that the main agents are Codex and VS Code chat?
- Is a billable project available for running `scripts/record-fixtures.cjs` once per vendor?
