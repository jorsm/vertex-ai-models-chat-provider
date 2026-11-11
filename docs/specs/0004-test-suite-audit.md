---
id: "0004"
title: Test suite audit
description: Inventory every existing test, decide per suite what to keep, rewrite or delete, then rewrite to the AGENTS.md test rules with shared helpers.
status: proposed
date: 2026-10-21
supersedes: none
code:
    - test/
---

# 0004 — Test suite audit

## Goal

Know what the existing tests actually check, and make every remaining test meet the test rules in `AGENTS.md` (spec 0001 D6). When this is done, a green `npm test` means something the owner can state: each suite targets named behavior, no test passes vacuously, and none breaks only because the catalog changed.

## Context

The suite grew over many sessions, before the test rules in `AGENTS.md` existed, and nothing records what each suite covers. Spec 0001 deliberately left existing tests alone ("rewriting existing tests" is one of its non-goals); this spec takes that work on.

Facts on `develop`, 21 Oct 2026:

- 16 files in `test/*.test.js`, about 7,400 lines and 369 tests (366 pass, 3 skipped), against about 10,700 lines in `src/`. `proxy.test.js` alone has 2,395 lines and 79 tests, covering at least 12 modules.
- **Recorder style dominates.** Most suites stub providers and capture calls. Only `proxy.test.js` runs a real SDK against a fake `fetch`, and all of those tests go through `ProxyGateway`. No SDK-level test covers the direct transport.
- **Positional assertions on recorders**, which AGENTS.md forbids: `h.calls.at(-1)[7]` in `proxy.test.js:780, 804, 820, 1820, 1885`; `h.calls[0][5]` in `commitMessage.test.js:190-198`.
- **Tests coupled to catalog contents:** `geminiCatalog.test.js:8-54` (Google model ID list, prices, limits); `claude-sonnet-5-5` in `discovery.test.js:141`, with exact request lists at `:184, :318`; hard-coded IDs in `proxy.test.js:2244` and `effortInference.test.js:189`.
- **Possibly vacuous selections:** `effortInference.test.js:308` picks a bundled model by property and is not checked for a match. B9 (spec 0002) left one such test vacuous, and `/code-review` caught it.
- **Ten files each build their own `vscode` stub** by patching `Module._load`. There is no shared test helper.
- **Skipped tests:** two live Grok tests (`grok46.test.js:298, 373`) that need `GROK46_LIVE_PROJECT`; one Windows-only test (`gcloudRunner.test.js:99`).
- **No test file imports:** `extension.ts`, `DashboardWebview.ts`, `auth/GcloudLogin.ts`, `auth/ProxyAuth.ts`, `commitMessage/CommitMessageGit.ts`, `effort/ThinkingEffortPicker.ts`, `utils/cancellation.ts`, `utils/Logger.ts`, `utils/tokens.ts`. Some may be covered indirectly; that is for D1 to establish.
- `test/host/` runs by hand in a real extension host, outside `npm test` and CI.

## Non-goals

- The transport parity suite (spec 0001 D7) and recorded fixtures (D8). This spec feeds them and follows them; it does not build them.
- Fixing production defects the audit finds. They go to spec 0002 as new items.
- Converting tests to TypeScript, or changing test runner.
- Live tests against real endpoints, and the release gate (`codex/live-adc-release-gate`).
- Raising coverage for its own sake. New tests are added only where D1 finds untested behavior that matters.

## Decisions

- New spec rather than a spec 0002 item: the first step is an inventory, not a known fix (owner, 20 Oct 2026).
- The catalog-coupled tests listed in Context are handled here, not as a separate spec 0002 item (owner, 20 Oct 2026).

## Behavior and invariants

- No production code changes, except to make code testable without changing behavior; each such change says so in its PR.
- A suite rewrite keeps or improves what the suite catches. The PR states, per deleted test, why it caught nothing or what now catches it instead.
- `npm test` stays green at every PR. A test that fails because it found a real defect is marked `{ todo: "spec 0002 B<n>" }` and the defect is filed.

## Deliverables

- [ ] D1. **Inventory.** One table in this spec, one row per suite: what it targets, its style (real SDK and fake `fetch`, recorder, pure unit), rule violations with locations, vacuous or redundant tests, and untested modules that matter. Read-only; produced by reading each suite in full, not by grep alone.
- [ ] D2. **Decisions.** Per suite: keep, rewrite or delete, with a reason, and the order of rewrites. Approved by the owner in review before D3 starts.
- [ ] D3. **Shared test helpers.** One `vscode` stub and the common fakes (fake `fetch` upstream, catalog builders) in a shared module under `test/`, used by the suites as they are rewritten.
- [ ] D4. **Catalog decoupling.** Tests select models through custom fixture catalogs or derive expectations from the catalog, and assert that a property-based selection found a model.
- [ ] D5. **Rewrites.** One PR per suite (or per small group touching the same module), in the D2 order. Recorder positional assertions replaced by assertions on what VS Code receives and on upstream requests.

## Acceptance checks

- D1: every file in `test/*.test.js` has a row; every violation listed in Context appears in it, or the row says why it is not one.
- D3: no test file patches `Module._load` on its own.
- D4: removing or renaming any one bundled model in `src/models.json` breaks no test except those that test the catalog file itself. Check by doing it on a scratch branch.
- D4: each property-based model selection fails with a clear message when nothing matches. Check by emptying the matching models in a fixture.
- D5: `grep -n "calls.at(-1)\[\|calls\[[0-9]\]\[[0-9]" test/` finds nothing.
- Whole spec: `npm test` passes; the test count may change, and each PR explains its change.

## Open questions

- Order against spec 0001 D7: the proposal is D1–D2 before the parity suite, because the inventory shows what parity can replace, and D3–D5 after it, so rewrites follow the parity suite as the SDK-level example. Owner to confirm.
- Should `proxy.test.js` be split by module as part of D5, or kept as one file?
- Is there behavior in the untested modules worth a new test (for example `utils/cancellation.ts`)? D1 proposes; D2 decides.
