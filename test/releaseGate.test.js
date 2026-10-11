const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { verifyReleaseArtifact } = require("../scripts/verify-live-release.cjs");

const expectedSourceSha = "1234567890abcdef1234567890abcdef12345678";
const environment = { GITHUB_ACTIONS: "true", GITHUB_RUN_ID: "123456", GITHUB_RUN_ATTEMPT: "1" };
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

async function fixture(t) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "vertex-release-gate-test-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const vsix = path.join(directory, "artifact.vsix");
    const reportPath = path.join(directory, "report.json");
    const bytes = Buffer.from("Independent artifact bytes used to test the publication digest gate.\n");
    await fs.writeFile(vsix, bytes);
    const models = { gemini: "gemini-live-model", claude: "claude-live-model" };
    const report = {
        schemaVersion: 1,
        startedAt: "2026-10-11T09:00:00Z",
        completedAt: "2026-10-11T09:01:00Z",
        ci: { runId: environment.GITHUB_RUN_ID, runAttempt: environment.GITHUB_RUN_ATTEMPT },
        source: { sha: expectedSourceSha },
        status: "passed",
        releaseEligible: true,
        setup: { status: "passed" },
        authentication: { method: "adc", identityVerified: true },
        host: { extensionMode: "production", version: "1.110.0", extensionVersion: "0.7.5" },
        catalog: { source: "seeded by installed extension" },
        configuration: { models },
        artifact: { path: vsix, sha256: createHash("sha256").update(bytes).digest("hex") },
        checks: mandatoryChecks.map(
            ([
                provider,
                feature,
            ]) => ({
                provider,
                feature,
                model: models[provider],
                status: "passed",
                evidence:
                    feature === "chat"
                        ? { reply: "CHAT_1234567890abcdef", textParts: 1 }
                        : feature === "tools"
                          ? { tool: "acceptance_add", input: { left: 102, right: 345 }, sum: 447, continuation: "TOOL_1234567890abcdef12345678" }
                          : { expected: "green,red,purple,blue,yellow", actual: "green,red,purple,blue,yellow", imageSha256: "a".repeat(64) },
            }),
        ),
    };
    const write = () => fs.writeFile(reportPath, JSON.stringify(report));
    await write();
    return { vsix, report, reportPath, write, options: { vsix, report: reportPath, expectedSourceSha, environment } };
}

test("publication verifies the actual artifact bytes and complete six-check ADC report", async (t) => {
    const f = await fixture(t);
    assert.deepEqual(await verifyReleaseArtifact(f.options), { sha256: f.report.artifact.sha256 });
    // Manual tag publication may have a dispatch SHA different from checked-out HEAD.
    await verifyReleaseArtifact({ ...f.options, environment: { ...environment, GITHUB_SHA: "b".repeat(40) } });
});

test("stale success cannot conceal any missing live provider feature", async (t) => {
    const f = await fixture(t);
    const checks = structuredClone(f.report.checks);
    for (let index = 0; index < checks.length; index++) {
        f.report.checks = checks.filter((_, candidate) => candidate !== index);
        await f.write();
        await assert.rejects(verifyReleaseArtifact(f.options), /six mandatory live checks/);
    }
    f.report.checks = structuredClone(checks);
    f.report.checks[5] = { ...f.report.checks[4] };
    await f.write();
    await assert.rejects(verifyReleaseArtifact(f.options), /matrix is incomplete/);
    f.report.checks = structuredClone(checks);
    f.report.checks[5].provider = "grok";
    await f.write();
    await assert.rejects(verifyReleaseArtifact(f.options), /matrix is incomplete/);
});

test("failed or skipped checks and host runner failures reject a stale eligibility flag", async (t) => {
    const f = await fixture(t);
    for (const status of [
        "failed",
        "skipped",
        "blocked",
        "running",
    ]) {
        f.report.checks[0].status = status;
        await f.write();
        await assert.rejects(verifyReleaseArtifact(f.options), /mandatory live check did not pass/);
    }
    f.report.checks[0].status = "passed";
    f.report.runnerError = "A process failed after emitting six passed rows.";
    await f.write();
    await assert.rejects(verifyReleaseArtifact(f.options), /did not complete successfully/);
    delete f.report.runnerError;
    f.report.status = "failed";
    await f.write();
    await assert.rejects(verifyReleaseArtifact(f.options), /did not complete successfully/);
});

test("release gate rejects unverified ADC and incomplete production setup", async (t) => {
    const f = await fixture(t);
    const passing = structuredClone(f.report);
    const corruptions = [
        (report) => delete report.authentication,
        (report) => (report.authentication.identityVerified = false),
        (report) => (report.authentication.method = "proxy"),
        (report) => (report.setup.status = "failed"),
        (report) => (report.setup.bootstrapOnly = true),
        (report) => delete report.host,
        (report) => (report.host.extensionMode = "development"),
        (report) => (report.catalog.source = "source checkout"),
    ];
    for (const corrupt of corruptions) {
        Object.assign(f.report, structuredClone(passing));
        corrupt(f.report);
        await f.write();
        await assert.rejects(verifyReleaseArtifact(f.options), /Release gate rejected:/);
    }
});

test("a report from another run, attempt, or source commit cannot authorize publication", async (t) => {
    const f = await fixture(t);
    f.report.ci.runId = "123455";
    await f.write();
    await assert.rejects(verifyReleaseArtifact(f.options), /different GitHub run or attempt/);
    f.report.ci.runId = environment.GITHUB_RUN_ID;
    f.report.ci.runAttempt = "2";
    await f.write();
    await assert.rejects(verifyReleaseArtifact(f.options), /different GitHub run or attempt/);
    f.report.ci.runAttempt = environment.GITHUB_RUN_ATTEMPT;
    f.report.source.sha = "a".repeat(40);
    await f.write();
    await assert.rejects(verifyReleaseArtifact(f.options), /checked-out source commit/);
    f.report.source.sha = expectedSourceSha;
    delete f.report.ci;
    await f.write();
    await assert.rejects(verifyReleaseArtifact(f.options), /different GitHub run or attempt/);
});

test("local success cannot serve as a GitHub publication report", async (t) => {
    const f = await fixture(t);
    await assert.rejects(verifyReleaseArtifact({ ...f.options, environment: {} }), /GitHub run identity is unavailable/);
    await assert.rejects(verifyReleaseArtifact({ ...f.options, environment: { ...environment, GITHUB_RUN_ATTEMPT: "" } }), /GitHub run identity is unavailable/);
});

test("a changed VSIX and a same-byte artifact at another path are both rejected", async (t) => {
    const f = await fixture(t);
    const original = await fs.readFile(f.vsix);
    await fs.appendFile(f.vsix, "mutation");
    await assert.rejects(verifyReleaseArtifact(f.options), /VSIX bytes do not match/);
    await fs.writeFile(f.vsix, original);
    const other = path.join(path.dirname(f.vsix), "other.vsix");
    await fs.writeFile(other, original);
    await assert.rejects(verifyReleaseArtifact({ ...f.options, vsix: other }), /different VSIX artifact/);
});

test("passing rows require the configured model and actual response evidence", async (t) => {
    const f = await fixture(t);
    const checks = structuredClone(f.report.checks);
    const corruptions = [
        (report) => (report.checks[0].model = "different-model"),
        (report) => (report.checks[0].evidence.textParts = 0),
        (report) => delete report.checks[1].evidence.continuation,
        (report) => (report.checks[1].evidence.sum = 0),
        (report) => (report.checks[2].evidence.actual = "red,green,blue,yellow,purple"),
        (report) => delete report.checks[2].evidence.imageSha256,
    ];
    for (const corrupt of corruptions) {
        f.report.checks = structuredClone(checks);
        corrupt(f.report);
        await f.write();
        await assert.rejects(verifyReleaseArtifact(f.options), /Release gate rejected:/);
    }
});

test("missing or invalid JSON errors expose no private report or path values", async (t) => {
    const f = await fixture(t);
    const privateValue = "private-account@example.invalid";
    await fs.writeFile(f.reportPath, `${privateValue} {invalid JSON`);
    await assert.rejects(verifyReleaseArtifact(f.options), { message: "Release gate rejected: live report could not be read." });
    await assert.rejects(verifyReleaseArtifact({ ...f.options, report: path.join(path.dirname(f.reportPath), privateValue) }), { message: "Release gate rejected: live report could not be read." });
});

test("publication CLI binds to checkout HEAD and exits unsuccessfully after artifact mutation", async (t) => {
    const f = await fixture(t);
    const root = path.resolve(__dirname, "..");
    f.report.source.sha = execFileSync(
        "git",
        [
            "rev-parse",
            "HEAD",
        ],
        { cwd: root, encoding: "utf8" },
    ).trim();
    await f.write();
    const run = () =>
        spawnSync(
            process.execPath,
            [
                path.join(root, "scripts", "verify-live-release.cjs"),
                "--vsix",
                f.vsix,
                "--report",
                f.reportPath,
            ],
            { cwd: root, env: { ...process.env, ...environment }, encoding: "utf8" },
        );
    const passing = run();
    assert.equal(passing.status, 0, passing.stderr);
    assert.match(passing.stdout, /Release gate passed for tested VSIX SHA256/);
    await fs.appendFile(f.vsix, "publication-time change");
    const rejected = run();
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /VSIX bytes do not match/);
    assert.equal(rejected.stdout, "");
    assert.ok(!rejected.stderr.includes(f.vsix));
});
