---
id: "0003"
title: Agent rule checks
description: Turn the AGENTS.md rules that today rely on the author agent's word into checks that fail in `npm run check` or CI, for every agent.
status: draft
supersedes: none
code:
    - eslint.config.mjs
    - package.json
    - scripts/
    - .github/workflows/
    - docs/specs/
---

# 0003 — Agent rule checks

## Goal

The owner reviews design and intent, not rule compliance. Every rule in `AGENTS.md` that a machine can check fails `npm run check` or CI when it is broken, so it holds the same for Claude Code, Codex and VS Code Copilot chat, and no longer depends on an agent ticking a box.

## Context

As of 20 Oct 2026, after specs 0001 and 0002 landed (#18–#20):

- Most rules in `AGENTS.md` are prose. The PR template's checkboxes are ticked by the author agent itself, so they are a statement, not a check. In #20 the agent ticked "Agent review run" for a review that covered only the first of three commits.
- Spec metadata drifted within a day: 0001 and 0002 stayed `draft` after merging, and D3 described branch protection that didn't exist (fixed in #21). Nothing would have caught it.
- Known violations of rules that are checkable: five empty `.catch(() => {})` (spec 0002 B6), optional calls on required methods (B7), prompt text and identity in logs (B11).
- Claude Code is the main agent, but Codex and VS Code Copilot chat only meet CI and the Husky pre-push hook. A check that lives in a Claude Code hook or skill doesn't hold for them.
- A spec `code` path that goes stale after a rename silently stops pointing agents at the spec.

## Non-goals

- Checking `AGENTS.md` against the code in CI. That stays human-gated through the `align-agents-md` skill, by the owner's decision.
- Rules that need judgment: one concern per PR, test quality, naming, design. Those stay with the owner's review.
- Proving that an agent review (`/code-review`, `/simplify`) ran. It can't be verified from the repo; the owner's review covers it.
- Fixing existing violations. Spec 0002 items do that; this spec makes sure they don't come back.

## Decisions

| Decision                                                                                                                                       | Made by       |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| Checks run in `npm run check` (local, pre-push, Stop hook) and in CI, never only in an agent-specific feature                                  | Owner, 20 Oct |
| A check that would fail on existing code lands together with, or after, the spec 0002 item that removes the violations                         | This spec     |
| Where a temporary exception list is unavoidable, it lives next to the check, names the spec item that will remove each entry, and only shrinks | This spec     |

## Behavior and invariants

- `npm run check` fails on: an empty catch handler without a stated reason; an optional call on a member whose type is not optional; spec metadata that is incomplete or disagrees with the index; a spec `code` path that matches no file.
- CI on a pull request also fails when the PR body does not reference a spec that governs a changed file, unless it says "none needed" with a reason.
- Every failure message names the rule and where it is written (`AGENTS.md` section or spec item), so an agent can fix it without asking.

## Deliverables

### D1. Empty catch handlers

- ESLint `no-restricted-syntax` rule in `eslint.config.mjs` that flags a `.catch(...)` whose handler has an empty body.
- A deliberate exception uses `// eslint-disable-next-line no-restricted-syntax -- <why ignoring is safe>`; ESLint reports unused disable directives, and `--max-warnings 0` turns that into a failure, so stale exceptions don't pile up.
- Delivered by #24 together with spec 0002 B6, ahead of this spec's approval.

### D2. Optional calls on required members

- Enable `@typescript-eslint/no-unnecessary-condition` (type-aware linting is already on through `projectService`), which flags `?.` on members whose type can't be nullish.
- Before enabling, measure how many existing hits it reports beyond B7's five. If the noise is large, scope it with the rule's options rather than dropping it, and record the choice here.
- Lands with or after spec 0002 B7.

### D3. Log privacy stays fixed

- The marker test from spec 0002 B11 (a known string in text, tool arguments and labels must never appear in captured logs) runs for every vendor provider on both transports, as part of `npm test`.
- `AGENTS.md` "Writing tests" says a new provider joins this test.
- Lands with or after spec 0002 B11.

### D4. Spec consistency check

A script `scripts/check-specs.mjs`, run by `npm run check`:

- every `docs/specs/NNNN-*.md` has all frontmatter fields from spec 0001 D1, a unique `id` matching its file name, and a `status` from the allowed set;
- `docs/specs/index.md` has exactly one row per spec, with the same id, title and status;
- every `code` path of a non-superseded spec matches at least one tracked file or directory.

No dependency on existing violations; can land first.

### D5. Governing-spec check on pull requests

A CI job on `pull_request` (a node script reading the event payload, no third-party action):

- maps the PR's changed files to the specs whose `code` paths cover them, ignoring `superseded` specs;
- fails if the PR body cites none of those spec ids and doesn't contain "none needed" in its Spec section;
- prints the governing specs it found, so the author knows what to read and cite.

### D6. PR size signal

- The same CI job reports the number of changed lines, excluding `package-lock.json`, `test/fixtures/` and generated files, as a warning annotation above a threshold. It never fails the build.

## Acceptance checks

- [x] A branch that adds `.catch(() => {})` without a reason fails `npm run check`.
- [ ] A branch that adds `foo.requiredMethod?.()` fails `npm run check`.
- [ ] A branch that renames a file listed in a spec's `code` paths, or changes a spec's status without the index, fails `npm run check`.
- [ ] A PR touching `src/providers/` whose body cites neither spec 0002 nor "none needed" fails CI, and the failure lists the governing specs.
- [ ] Every check above also fails for a Codex or VS Code Copilot chat session (it runs in `npm run check` or CI, not in a Claude Code hook).

## Rollout

| PR  | Content                                 | Depends on           |
| --- | --------------------------------------- | -------------------- |
| 1   | D4 spec consistency check               | this spec approved   |
| 2   | D5 governing-spec check, D6 size signal | 1                    |
| 3   | D1 empty catches                        | done in #24          |
| 4   | D2 optional calls                       | spec 0002 B7 merged  |
| 5   | D3 log privacy                          | spec 0002 B11 merged |

## Open questions

- D5: specs 0001 and 0002 govern broad paths (`test/`, `package.json`, `src/providers/`), so most PRs will have to cite them. Fail on every governing spec, or fail only for `approved` specs and warn for `implemented` ones?
- D6: what threshold? 400 changed lines is a common starting point.
- D1: also require a reason on every `eslint-disable` comment (needs the `@eslint-community/eslint-plugin-eslint-comments` dev dependency), or only on this rule?
