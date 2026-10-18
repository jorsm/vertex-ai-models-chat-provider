---
name: align-agents-md
description: Check that AGENTS.md still matches the code after the changes on this branch, and update it in the same PR. Use before opening or updating a PR, after /code-review and /simplify, or when asked whether AGENTS.md has drifted. Pass "full" to audit every statement, not only those the branch touches.
---

# Align AGENTS.md with the code

`AGENTS.md` primes every agent session in this repo. A false statement in it misleads every agent that branches from `develop`, so each PR leaves it true for the code it merges.

## 1. Find what changed

```sh
git fetch origin develop
git diff --name-only origin/develop...HEAD
git status --short
```

With `full`, skip this step and check every statement in step 2.

## 2. Find the statements that depend on it

Read `AGENTS.md` in full. A statement is affected when the branch:

- renames, moves, deletes or adds a file or folder the **Map** names, or adds a top-level area under `src/` that the Map should name;
- changes `package.json` scripts, `.husky/` or the tooling behind **Commands**;
- changes transport, discovery, auth, retry, labels, logging or cancellation code (**Direct and proxy**, **Invariants**);
- fixes or adds a defect that `AGENTS.md` cites by spec 0002 item (B1, B5, B11, …);
- changes test helpers or patterns that **Writing tests** points to;
- changes `.github/`, branch rules or the PR template (**Pull requests**).

## 3. Verify each one against the code

Read the code, not other docs. For each affected statement, decide: still true, false, or incomplete. Also confirm that every path and `npm run` command the file names exists (expand `{a,b}` forms).

When the code and `AGENTS.md` disagree, work out which is wrong before editing. If the code broke an invariant or added a direct/proxy difference, that is a bug in the change: report it, and don't edit `AGENTS.md` to match.

## 4. Edit

- Change only what the branch made false or incomplete. Keep the existing wording, sections and table style.
- Describe what exists on this branch. No plans, no "will", no "once it exists"; those go in `docs/specs/`.
- No generic advice and nothing an agent can find by listing files.
- Stay under 150 lines.
- A new row in the declared-divergences table, or a weakened invariant, needs an approved spec. Link it, or stop and ask.
- Drift the branch didn't cause: list it under "Out of scope" in the PR description; don't fix it here.

Commit separately: `docs(agents): align AGENTS.md with <change>`.

## 5. Report

In the PR description's Docs section, tick the `AGENTS.md` box and say either "updated: <sections>" or "still accurate: checked <sections>". Name any statement you could not verify.
