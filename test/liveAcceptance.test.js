const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { completeReport, blockPending } = require("./live/support.cjs");
const { childEnvironment, supervised, assertArtifact } = require("../scripts/test-live.cjs");

// Keep the acceptance contract independent of the runner's exported provider/feature lists.
const mandatoryChecks = [
    [
        "gemini",
        "chat",
    ],
    [
        "gemini",
        "tools",
    ],
    [
        "gemini",
        "image",
    ],
    [
        "claude",
        "chat",
    ],
    [
        "claude",
        "tools",
    ],
    [
        "claude",
        "image",
    ],
];

function passingReport() {
    return {
        setup: { status: "passed" },
        checks: mandatoryChecks.map(
            ([
                provider,
                feature,
            ]) => ({ provider, feature, status: "passed" }),
        ),
    };
}

function assertFailed(report, description) {
    assert.equal(report.releaseEligible, false, description);
    assert.equal(report.status, "failed", description);
}

test("live acceptance requires Gemini and Claude chat, tools, and image results", () => {
    const passing = completeReport(passingReport());
    assert.equal(passing.releaseEligible, true);
    assert.equal(passing.status, "passed");

    for (const [
        provider,
        feature,
    ] of mandatoryChecks) {
        const report = passingReport();
        report.checks = report.checks.filter((check) => check.provider !== provider || check.feature !== feature);
        // A stale success must also be cleared when a persisted report is incomplete.
        report.releaseEligible = true;
        report.status = "passed";
        assertFailed(completeReport(report), `Missing ${provider}:${feature} must fail acceptance`);
    }
});

test("duplicate successes and substitute checks cannot hide a missing live feature", () => {
    const duplicate = passingReport();
    duplicate.checks[5] = { ...duplicate.checks[4] };
    assertFailed(completeReport(duplicate), "Six rows containing a duplicate must fail");

    const additionalDuplicate = passingReport();
    additionalDuplicate.checks.push({ ...additionalDuplicate.checks[0] });
    assertFailed(completeReport(additionalDuplicate), "The report must contain exactly the six required checks");

    const substitute = passingReport();
    substitute.checks[5] = { provider: "local-mock", feature: "image", status: "passed" };
    assertFailed(completeReport(substitute), "An unknown provider cannot substitute for Claude image support");
});

test("Grok cannot substitute for Claude and a stale nine-check report cannot pass the current contract", () => {
    const substitute = passingReport();
    for (const check of substitute.checks) if (check.provider === "claude") check.provider = "grok";
    assertFailed(completeReport(substitute), "Successful Grok results cannot satisfy mandatory Claude checks");

    const stale = passingReport();
    stale.checks.push(
        ...[
            "chat",
            "tools",
            "image",
        ].map((feature) => ({ provider: "grok", feature, status: "passed" })),
    );
    stale.releaseEligible = true;
    assertFailed(completeReport(stale), "The previous nine-check report must be rerun under the current scope");
});

test("a failed, skipped, blocked, or unfinished live check makes the report fail", () => {
    for (const status of [
        "failed",
        "skipped",
        "blocked",
        "running",
        undefined,
    ]) {
        const report = passingReport();
        report.checks[4].status = status;
        assertFailed(completeReport(report), `A ${String(status)} tools check must fail acceptance`);
    }
    for (const setup of [
        undefined,
        { status: "failed" },
        { status: "running" },
    ]) {
        const report = passingReport();
        report.setup = setup;
        assertFailed(completeReport(report), "Successful inference cannot replace successful installed-extension setup");
    }
});

test("a runner failure cannot become green when every individual assertion passed", () => {
    for (const finalize of [
        completeReport,
        (report) => blockPending(report, report.runnerError),
    ]) {
        const report = passingReport();
        report.runnerError = "The extension host exited unsuccessfully after writing its assertions.";
        assertFailed(finalize(report), "A persisted host failure must survive report finalization");
    }
});

test("an interrupted report preserves real partial results and blocks all unexecuted checks", () => {
    const report = {
        setup: { status: "passed" },
        checks: [
            { provider: "gemini", feature: "chat", status: "passed", response: "verified answer" },
            { provider: "gemini", feature: "tools", status: "failed", error: "Tool result was not used." },
            { provider: "claude", feature: "image", status: "passed", response: "verified colors" },
        ],
    };
    const completed = blockPending(report, "Host timed out.");
    assertFailed(completed);
    assert.equal(completed.checks.length, 6);
    assert.equal(completed.checks.find((check) => check.provider === "gemini" && check.feature === "chat").response, "verified answer");
    assert.equal(completed.checks.find((check) => check.provider === "gemini" && check.feature === "tools").error, "Tool result was not used.");
    assert.equal(completed.checks.find((check) => check.provider === "claude" && check.feature === "image").status, "passed");
    assert.equal(completed.checks.filter((check) => check.status === "blocked" && check.error === "Host timed out.").length, 3);
});

async function privateDirectory(t, automaticallyRemove = true) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "vertex-live-safety-"));
    await fs.chmod(directory, 0o700);
    if (automaticallyRemove) t.after(() => fs.rm(directory, { recursive: true, force: true }));
    return directory;
}

test("the real child environment rejects inherited SDK redirects and references ADC in place", async (t) => {
    const directory = await privateDirectory(t);
    const inheritedAdc = path.join(directory, "inherited adc.json");
    const explicitAdc = path.join(directory, "explicit adc.json");
    const fixture = '{"fixture":"noncredential safety test"}\n';
    await fs.writeFile(inheritedAdc, fixture, { mode: 0o600 });
    await fs.writeFile(explicitAdc, fixture, { mode: 0o600 });
    const inherited = {
        ELECTRON_RUN_AS_NODE: "1",
        NODE_OPTIONS: "--require /nonexistent/untrusted-bootstrap.cjs",
        GOOGLE_VERTEX_BASE_URL: "http://127.0.0.1:1/fake-vertex",
        GOOGLE_GEMINI_BASE_URL: "http://127.0.0.1:1/fake-gemini",
        ANTHROPIC_VERTEX_BASE_URL: "http://127.0.0.1:1/fake-anthropic",
        OPENAI_BASE_URL: "http://127.0.0.1:1/fake-openai",
        GOOGLE_API_KEY: "synthetic-google-key",
        GEMINI_API_KEY: "synthetic-gemini-key",
        ANTHROPIC_API_KEY: "synthetic-anthropic-key",
        OPENAI_API_KEY: "synthetic-openai-key",
        ANTHROPIC_AUTH_TOKEN: "synthetic-anthropic-token",
        GOOGLE_APPLICATION_CREDENTIALS: inheritedAdc,
        GOOGLE_CLOUD_QUOTA_PROJECT: "inherited-fixture-project",
    };
    const previous = Object.fromEntries(
        Object.keys(inherited).map((key) => [
            key,
            process.env[key],
        ]),
    );
    t.after(() => {
        for (const [
            key,
            value,
        ] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });
    Object.assign(process.env, inherited);

    const ambient = childEnvironment({ project: "selected-fixture-project" });
    const explicit = childEnvironment({ project: "selected-fixture-project", adcFile: explicitAdc });
    assert.equal(ambient.GOOGLE_APPLICATION_CREDENTIALS, inheritedAdc);
    assert.equal(explicit.GOOGLE_APPLICATION_CREDENTIALS, explicitAdc);
    assert.equal(explicit.GOOGLE_CLOUD_QUOTA_PROJECT, "selected-fixture-project");
    assert.deepEqual(
        Object.fromEntries(
            Object.keys(inherited).map((key) => [
                key,
                process.env[key],
            ]),
        ),
        inherited,
        "Preparing acceptance must not change the caller's environment",
    );

    // Launch an actual process: an unsanitized NODE_OPTIONS would prevent startup.
    const child = spawnSync(
        process.execPath,
        [
            "-e",
            `const fs = require("node:fs");
            const forbidden = ["ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "GOOGLE_VERTEX_BASE_URL", "GOOGLE_GEMINI_BASE_URL", "ANTHROPIC_VERTEX_BASE_URL", "OPENAI_BASE_URL", "GOOGLE_API_KEY", "GEMINI_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_AUTH_TOKEN"];
            console.log(JSON.stringify({
                redirectsPresent: forbidden.filter(key => process.env[key] !== undefined),
                adcPathMatches: process.env.GOOGLE_APPLICATION_CREDENTIALS === process.argv[1],
                adcFixtureMatches: fs.readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, "utf8") === process.argv[2],
                quotaProject: process.env.GOOGLE_CLOUD_QUOTA_PROJECT
            }));`,
            explicitAdc,
            fixture,
        ],
        { env: explicit, encoding: "utf8", timeout: 5000 },
    );
    assert.equal(child.error, undefined);
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), { redirectsPresent: [], adcPathMatches: true, adcFixtureMatches: true, quotaProject: "selected-fixture-project" });
    assert.equal(await fs.readFile(inheritedAdc, "utf8"), fixture);
    assert.equal(await fs.readFile(explicitAdc, "utf8"), fixture);
    assert.deepEqual((await fs.readdir(directory)).sort(), [
        "explicit adc.json",
        "inherited adc.json",
    ]);
});

test("replacing artifact bytes after acceptance invalidates the recorded VSIX hash", async (t) => {
    const directory = await privateDirectory(t);
    const artifact = path.join(directory, "artifact.vsix");
    const hash = async () =>
        createHash("sha256")
            .update(await fs.readFile(artifact))
            .digest("hex");
    await fs.writeFile(artifact, "packaged extension version A", { mode: 0o600 });
    const recorded = await hash();
    assert.doesNotThrow(() => assertArtifact(recorded, recorded));
    await fs.writeFile(artifact, "packaged extension version B");
    const replacement = await hash();
    assert.notEqual(replacement, recorded);
    assert.throws(() => assertArtifact(recorded, replacement), /VSIX changed|hash no longer matches/);
});

test("successful-looking host output cannot hide an unsuccessful process exit", async (t) => {
    const directory = await privateDirectory(t);
    const logPath = path.join(directory, "private.log");
    await assert.rejects(
        supervised(
            process.execPath,
            [
                "-e",
                'console.log("All six checks passed."); process.exitCode = 7;',
            ],
            childEnvironment({ project: "fixture-project" }),
            logPath,
            5,
        ),
        /Process exited with code 7/,
    );
    assert.match(await fs.readFile(logPath, "utf8"), /All six checks passed/);
    if (process.platform !== "win32") assert.equal((await fs.stat(logPath)).mode & 0o777, 0o600);
});

async function running(pid) {
    try {
        process.kill(pid, 0);
    } catch (error) {
        if (error.code === "ESRCH") return false;
        throw error;
    }
    if (process.platform === "linux") {
        try {
            const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
            // An orphaned zombie is dead and cannot issue further cloud requests.
            if (
                [
                    "Z",
                    "X",
                ].includes(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0])
            )
                return false;
        } catch (error) {
            if (error.code === "ENOENT") return false;
            throw error;
        }
    }
    return true;
}

async function waitUntil(predicate, milliseconds) {
    const deadline = Date.now() + milliseconds;
    do {
        if (await predicate()) return true;
        await new Promise((resolve) => setTimeout(resolve, 25));
    } while (Date.now() < deadline);
    return false;
}

test("a timed-out host kills a real descendant that ignores SIGTERM, even after the host exits", { skip: process.platform === "win32" ? "POSIX process-group regression" : false, timeout: 15000 }, async (t) => {
    const directory = await privateDirectory(t, false);
    const pidPath = path.join(directory, "descendant.json");
    const logPath = path.join(directory, "private.log");
    let tree;
    t.after(async () => {
        if (!tree) {
            try {
                tree = JSON.parse(await fs.readFile(pidPath, "utf8"));
            } catch {}
        }
        try {
            if (tree) {
                // Cleanup also runs when the regression exposes a surviving descendant.
                for (const pid of [
                    -tree.parent,
                    tree.descendant,
                ]) {
                    try {
                        process.kill(pid, "SIGKILL");
                    } catch (error) {
                        if (error.code !== "ESRCH") throw error;
                    }
                }
            }
        } finally {
            await fs.rm(directory, { recursive: true, force: true });
        }
    });
    const descendant = `const fs = require("node:fs");
        process.on("SIGTERM", () => {});
        fs.writeFileSync(process.argv[1], JSON.stringify({ parent: process.ppid, descendant: process.pid }), { mode: 0o600 });
        setInterval(() => {}, 100);`;
    const host = `const { spawn } = require("node:child_process");
        spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}, process.argv[1]], { stdio: "ignore" });
        setInterval(() => {}, 100);`;
    const outcome = supervised(
        process.execPath,
        [
            "-e",
            host,
            pidPath,
        ],
        childEnvironment({ project: "fixture-project" }),
        logPath,
        2,
    ).then(
        () => ({ passed: true }),
        (error) => ({ error }),
    );
    assert.equal(
        await waitUntil(async () => {
            try {
                tree = JSON.parse(await fs.readFile(pidPath, "utf8"));
                return true;
            } catch (error) {
                if (error.code === "ENOENT" || error instanceof SyntaxError) return false;
                throw error;
            }
        }, 1500),
        true,
        "The real descendant must start before the timeout",
    );
    assert.equal(await running(tree.parent), true);
    assert.equal(await running(tree.descendant), true);
    const result = await outcome;
    assert.match(result.error?.message || "", /Process exceeded 2s/);
    assert.equal(await waitUntil(async () => !(await running(tree.descendant)), 4500), true, "The SIGKILL escalation must outlive the host's exit; its descendant could otherwise keep running requests");
    assert.equal((await fs.stat(logPath)).mode & 0o777, 0o600, "Process output must remain private");
    assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
});
