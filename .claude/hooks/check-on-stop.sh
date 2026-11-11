#!/usr/bin/env bash
# Claude Code Stop hook (spec 0001 D4): run `npm run check` before the agent
# finishes and hand any failure back to it (exit 2 feeds stderr to the agent).
set -u

input=$(cat)

# Second stop after a block: let the agent finish so an unfixable failure
# cannot loop forever. The agent was told to explain it instead.
if printf '%s' "$input" | grep -q '"stop_hook_active"[[:space:]]*:[[:space:]]*true'; then
    exit 0
fi

# Check the tree the session works in. In a worktree session that is the
# worktree (the input's `cwd`), not CLAUDE_PROJECT_DIR, the main checkout.
cwd=$(printf '%s' "$input" | node -e 'let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => { try { process.stdout.write(JSON.parse(s).cwd || ""); } catch {} });')
root=$(git -C "${cwd:-${CLAUDE_PROJECT_DIR:-.}}" rev-parse --show-toplevel 2>/dev/null) || exit 0
cd "$root" || exit 0

# Nothing edited and nothing unpushed: a conversation-only turn, skip the check.
if [ -z "$(git status --porcelain)" ] && [ -z "$(git log --oneline '@{u}..HEAD' 2>/dev/null)" ]; then
    exit 0
fi

if ! output=$(npm run check 2>&1); then
    {
        echo "npm run check failed. Fix the failure before finishing, or tell the user why it cannot pass."
        echo
        printf '%s\n' "$output" | tail -n 80
    } >&2
    exit 2
fi
