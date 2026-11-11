#!/usr/bin/env node
// Deterministic checks for AGENTS.md: every path it names exists, every npm
// command is a package.json script, every named setting or command id is
// declared in contributes, every cited spec and spec item exists, and the
// file stays within 150 lines. Prints one line per problem; exits 1 if any.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

const MAX_LINES = 150;
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const root = git("rev-parse", "--show-toplevel");
const text = readFileSync(join(root, "AGENTS.md"), "utf8");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const scripts = pkg.scripts ?? {};
const contributedIds = new Set([
    ...[pkg.contributes?.configuration ?? []].flat().flatMap((c) => Object.keys(c.properties ?? {})),
    ...(pkg.contributes?.commands ?? []).map((c) => c.command),
]);
const idPrefixes = new Set([...contributedIds].map((id) => id.split(".")[0]));
// Tracked plus untracked-but-not-ignored, so paths a branch adds before its first commit
// count; files deleted or moved but not yet staged don't.
const listFiles = (...pathspec) =>
    git("-C", root, "ls-files", "-co", "--exclude-standard", "--", ...pathspec)
        .split("\n")
        .filter((f) => f && existsSync(join(root, f)));
const fileNames = new Set(listFiles().map((f) => basename(f)));
const problems = [];
const counts = { paths: 0, commands: 0, ids: 0, specs: 0 };

// `src/{a,b}/x.ts` -> ["src/a/x.ts", "src/b/x.ts"]
function expandBraces(s) {
    const m = s.match(/\{([^{}]*)\}/);
    if (!m) return [s];
    return m[1].split(",").flatMap((alt) => expandBraces(s.replace(m[0], alt)));
}

function isIgnored(p) {
    try {
        execFileSync("git", [
            "-C",
            root,
            "check-ignore",
            "-q",
            p,
        ]);
        return true;
    } catch {
        return false;
    }
}

function pathExists(p) {
    const clean = p.replace(/\/$/, "");
    if (clean.includes("*")) {
        // git's glob pathspec: `*` stays within one segment, `**/` spans directories.
        return listFiles(`:(glob)${clean}`).length > 0;
    }
    return existsSync(join(root, clean));
}

const lines = text.split("\n");
if (lines.length > MAX_LINES) problems.push(`AGENTS.md has ${lines.length} lines (max ${MAX_LINES})`);

lines.forEach((line, i) => {
    const at = `AGENTS.md:${i + 1}`;
    for (const [
        ,
        span,
    ] of line.matchAll(/`([^`]+)`/g)) {
        // Commands: `npm run x`, `npm test`.
        for (const [
            ,
            name,
        ] of span.matchAll(/\bnpm run ([\w:.-]+)/g)) {
            counts.commands++;
            if (!(name in scripts)) problems.push(`${at}: npm script "${name}" not in package.json`);
        }
        if (/\bnpm test\b/.test(span)) {
            counts.commands++;
            if (!("test" in scripts)) problems.push(`${at}: npm script "test" not in package.json`);
        }
        // Paths: tokens with a slash or a file extension. Skip packages (@x/y),
        // slash commands (/x), placeholders (…, NNNN) and git-ignored output.
        for (let token of span.split(/\s+/)) {
            token = token.replace(/[,;:)]+$/, "");
            // Setting and command ids like vertexAiChat.x; other dotted names (Logger.log) are not checked.
            if (/^[\w-]+(\.[\w-]+)+$/.test(token) && idPrefixes.has(token.split(".")[0])) {
                counts.ids++;
                if (!contributedIds.has(token)) problems.push(`${at}: ${token} is not a setting or command declared in package.json`);
                continue;
            }
            const looksLikePath = /^[\w.{},*/-]+$/.test(token) && (token.includes("/") || /\.(ts|js|mjs|cjs|json|md)$/.test(token));
            if (!looksLikePath || token.startsWith("/") || token.includes("…") || /NNNN/.test(token)) continue;
            for (const p of expandBraces(token)) {
                counts.paths++;
                if (!p.includes("/")) {
                    if (!fileNames.has(p) && !isIgnored(p)) problems.push(`${at}: no file named ${p}`);
                } else if (!pathExists(p) && !isIgnored(p)) {
                    problems.push(`${at}: path ${p} does not exist`);
                }
            }
        }
    }
    // Spec citations: "spec 0002", "spec 0002 B5", "spec 0001, D1".
    for (const [
        ,
        id,
        item,
    ] of line.matchAll(/\bspec (\d{4})\b,?\s*([A-Z]\d+\b)?/g)) {
        counts.specs++;
        const file = readdirSync(join(root, "docs/specs")).find((f) => f.startsWith(`${id}-`));
        if (!file) {
            problems.push(`${at}: spec ${id} not found in docs/specs/`);
            continue;
        }
        if (item && !readFileSync(join(root, "docs/specs", file), "utf8").match(new RegExp(`(\\*\\*|#+ )${item}[.\\s]`))) {
            problems.push(`${at}: spec ${id} has no item ${item}`);
        }
    }
});

for (const p of problems) console.log(p);
console.log(`${problems.length ? "FAIL" : "OK"}: ${counts.paths} paths, ${counts.commands} commands, ${counts.ids} settings/command ids, ${counts.specs} spec citations, ${lines.length} lines`);
process.exit(problems.length ? 1 : 0);
