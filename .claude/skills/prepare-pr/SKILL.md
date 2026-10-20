---
name: prepare-pr
description: The one sequence to run before opening or updating a PR in this repo. Runs the checks and agent reviews in order, ticks the spec items or deliverables the branch completes, updates spec status and the specs index, adds the CHANGELOG entry, runs align-agents-md, then opens the PR from the template. Use it whenever a branch is ready for review, when someone says "open a PR", "prepare the PR", "ready for review" or "ship this branch", and before pushing new commits to an open PR.
---

# Prepare a PR

This skill is the only place that states the order of steps before a PR (spec 0001 D3). `AGENTS.md` and the PR template point here. Run every step in order; when you skip one, say which and why in the PR's Review section. A skipped or failing check is not a pass.

The base is `develop`, unless the PR targets another branch. Compare against the merge base, including uncommitted work:

```sh
git fetch origin develop
MB=$(git merge-base origin/develop HEAD)
git diff --name-status "$MB"
git ls-files --others --exclude-standard
```

## 1. Branch

- Cut from `develop`, one concern. If the diff carries an unrelated change (a catalog edit, a version bump, a refactor), move it to its own branch before going on.
- Name: `spec/NNNN-slug` for spec-only PRs, otherwise `feat/…`, `fix/…`, `chore/…` or `test/…`. Name the spec items it implements: `fix/0002-b6-b7-catch-and-optional-calls`. The type follows Conventional Commits: `fix` only when something was broken (removing a superseded model is `chore`).

## 2. `npm run check`

Format check, lint and tests. Fix every failure before going on.

## 3. `/code-review`

Always, on the branch (other tools: their equivalent). Apply the findings that hold up; commit them separately from the feature commits, with their own Conventional Commit message. Note findings you reject and why, for the PR's Details.

## 4. `/simplify`

Skip only when every changed file is Markdown (docs, specs, skills). Otherwise run it and commit its changes separately.

## 5. Specs

For each spec whose `code` paths the branch touches, or that the branch implements:

- **Backlog item fixed** (e.g. spec 0002 B6): tick its box (`- [x] **B6. …**`) and add a last bullet `- Fixed: <one line: what changed>`. No PR number: the PR can't cite its own number, and `git log` finds it.
- **Deliverable completed:** tick its box (`- [x] D3. …`, or `- [x] Delivered` under a `### D3.` heading). Tick acceptance checks the branch now satisfies.
- **Status:** if the branch ticks the last deliverable, set `status: implemented`. Statuses and their meaning are in spec 0001 D1. Change the spec's row in `docs/specs/index.md` in the same commit.
- **Behavior change:** if the branch changes behavior a spec describes, update the spec and call it out in the PR description. Never rewrite acceptance checks to match what was built.
- **Spec-only PR:** keep `status: proposed` until the owner's review has no more changes, then set `accepted` (spec and index) in a last commit before merge.

Commit as `docs(specs): …`.

## 6. `CHANGELOG.md`

Add an entry under `## [Unreleased]` when the branch changes what the packaged extension contains or does: code under `src/`, the bundled catalog, settings or commands in `package.json`, dependencies, `media/`, `schemas/`. Do it even when users won't notice. Tests, specs, `AGENTS.md`, skills, CI and hooks get no entry, and neither do README-only edits.

Use the Keep a Changelog subsections (`### Added`, `### Changed`, `### Fixed`, `### Removed`) and write for users. If `## [Unreleased]` is missing, add it above the latest release.

## 7. `/align-agents-md`

Run the project skill (other tools: follow `.claude/skills/align-agents-md/SKILL.md`). Keep its report block for the PR's Docs section.

## 8. Re-check

If steps 3 to 7 changed files, run `npm run check` again. In Claude Code the Stop hook also runs it.

## 9. Open the PR

- Push the branch and open the PR against `develop` with `.github/pull_request_template.md`. Title in Conventional Commits.
- Fill every section: the spec link (or "none needed" and why); the commands from steps 2 and 8 with their results; the Transport impact option that applies; the Docs boxes and the align-agents-md report line; the Review box with any skipped steps; out-of-scope findings.
- When updating an open PR, update its description to match the new commits.

## 10. Report

End with: the PR link, the commands run and their results, the steps skipped and why, and the spec items ticked.
