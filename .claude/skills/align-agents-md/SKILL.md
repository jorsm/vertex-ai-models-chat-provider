---
name: align-agents-md
description: Keep AGENTS.md true for the code a branch will merge. Checks the AGENTS.md statements a branch could affect (paths, commands, settings and defaults, direct/proxy rules, invariants, cited spec items, test and PR rules), fixes the ones it made false with minimal edits, flags changes that break a rule instead, and reports what was checked. Use it before opening or updating any PR in this repo, after /code-review and /simplify, and whenever someone asks whether AGENTS.md is stale, outdated or drifted, or after renaming or moving files, adding npm scripts, changing a setting default, or fixing a known defect. Pass "full" to audit the whole file.
---

# Align AGENTS.md with the code

`AGENTS.md` is loaded into every agent session in this repo, and agents trust it before they have read any code. One stale line therefore produces wrong work in every later session that branches from `develop`. No CI job checks it: this skill, run by the author's agent, and the owner's review are what keep it true.

The goal is precision, not activity. Most branches need no edit, and "still accurate" after a real check is a good result. Every line added is paid for by every future session, so add only what the next agent would otherwise get wrong.

## Modes

- **Branch (default):** check the statements this branch could affect. Fix what the branch made false; report other drift without fixing it, because a PR carries one concern.
- **`full`:** check every statement and fix all drift. Run it on its own branch cut from `develop` (e.g. `chore/align-agents-md`) so the fixes get their own PR.

## 1. Find what the branch changed

The base is the branch the PR merges into: `develop`, unless the PR targets another branch (stacked PRs). Compare against the merge base, so commits that reached the base after you branched don't look like yours, and include work not yet committed:

```sh
git fetch origin develop                      # or the PR's base branch
MB=$(git merge-base origin/develop HEAD)
git diff --name-status "$MB"                  # committed and uncommitted
git ls-files --others --exclude-standard      # new untracked files
```

File names alone don't show that a default or a behavior changed. Read the diff (`git diff "$MB" -- <file>`) for every file that looks related to something `AGENTS.md` says.

In `full` mode, skip this step.

## 2. Run the reference check

```sh
node .claude/skills/align-agents-md/scripts/check-references.mjs
```

It reports paths named in `AGENTS.md` that don't exist, `npm` commands missing from `package.json`, cited specs or spec items (`spec 0002 B5`) that don't exist, and a file over 150 lines. Its results are facts, not judgment: fix each hit, or say why it is a false alarm. A clean run says nothing about whether statements are still _true_; that is step 3.

## 3. Check each statement the change could affect

Read `AGENTS.md` in full. For each statement, ask which code makes it true and whether the branch touched that code. Then open that code and confirm; don't rely on specs, other docs or commit messages, which may be stale themselves. Typical links, as examples (the sections of `AGENTS.md` change over time, so go by what the file says now):

- a path, and the file at that path: renamed, moved, deleted, or its role changed;
- a command, and `package.json` scripts, `.husky/` and tool configs;
- a setting name or default, and where it is declared (`contributes.configuration` in `package.json`) and read;
- a direct/proxy statement, and the transport, auth, retry, label, logging and cancellation code of **both** transports;
- a "currently violates" or known-gap sentence citing a spec 0002 item, and the code that item names. When the branch fixes the defect, that sentence shrinks or goes;
- a test rule, and the test file or helper it points to;
- a PR rule, and `.github/` and the PR template.

Then the other direction: does the branch add something an agent would get wrong without being told? That covers a new area of code the map should route to, a new command contributors run, or a new invariant or declared divergence (which needs an approved spec). Helper names, implementation details and anything found by listing files don't qualify.

## 4. When code and AGENTS.md disagree, decide which is wrong

- **Legitimate change made a statement stale** (a rename, a new script, a fixed defect): edit `AGENTS.md`.
- **The change breaks a rule `AGENTS.md` sets** (a new direct/proxy difference, a second retry layer, prompt text in logs, a dropped billing label): the code is wrong. Leave `AGENTS.md` alone and report it as blocking, since editing the file would silently legalize the bug for every later session.
- **The change deliberately alters a rule** (a divergence row, an invariant, a retry policy): that needs an approved spec. If the branch has one, edit `AGENTS.md` and link it; if not, stop and ask the user.
- **Drift the branch didn't cause:** in branch mode, report it as out of scope; in `full` mode, fix it.

## 5. Edit

- Make the smallest change that makes the statement true. Keep the existing wording, section order and table style, then run `npx prettier --write AGENTS.md` (it realigns tables).
- Write in the present tense about what exists on the branch. Plans and "once it exists" belong in `docs/specs/`.
- Stay within 150 lines. If an addition would cross it, tighten something else and say what.
- If the PR template or this skill names something the branch renamed, fix it too.
- Commit separately as `docs(agents): align AGENTS.md with <change>`. If nothing changed, don't commit.

## 6. Report

End with this block, for the user and for the Docs section of the PR description:

```
AGENTS.md: updated (<sections>) | still accurate
Checked: <each statement or section, and the code you read for it>
Blocking: <rules the change breaks (step 4), or none>
Out of scope: <drift the branch didn't cause, or none>
Not verified: <statements you couldn't check, and why, or none>
```

If a PR exists and you can edit its description, tick the `AGENTS.md` box in its Docs section and add the first line; otherwise leave that to the user.
