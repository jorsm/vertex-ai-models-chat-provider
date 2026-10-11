const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { loadConfiguration, publicReport } = require("./live/configuration.cjs");

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vertex-live-env-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    return root;
}

test("injected environment overrides dotenv and explicit CLI overrides both, without changing caller environment", async (t) => {
    const root = await fixture(t);
    await fs.writeFile(path.join(root, ".env"), "VERTEX_LIVE_PROJECT_ID=dotenv-project\nVERTEX_LIVE_EXPECTED_ACCOUNT=local@example.invalid\nVERTEX_LIVE_GEMINI_MODEL=dotenv-model\nVERTEX_LIVE_REQUEST_TIMEOUT_SECONDS=37\n");
    const environment = { VERTEX_LIVE_PROJECT_ID: "injected-project", VERTEX_LIVE_GEMINI_MODEL: "injected-model" };
    const previous = { ...environment };
    const injected = await loadConfiguration({ root, environment });
    assert.equal(injected.project, "injected-project");
    assert.equal(injected.models.gemini, "injected-model");
    assert.equal(injected.expectedAccount, "local@example.invalid");
    assert.equal(injected.requestTimeoutSeconds, 37);
    const explicit = await loadConfiguration({ root, environment, values: { project: "cli-project", "gemini-model": "cli-model", "expected-account": "" } });
    assert.equal(explicit.project, "cli-project");
    assert.equal(explicit.models.gemini, "cli-model");
    assert.equal(explicit.expectedAccount, "");
    assert.deepEqual(environment, previous);
});

test("CI never silently selects local project or credentials and rejects credential conflicts", async (t) => {
    const root = await fixture(t);
    const generated = path.join(root, "gha-creds-fixture.json");
    await fs.writeFile(generated, "noncredential fixture");
    await fs.writeFile(path.join(root, ".env"), "VERTEX_LIVE_PROJECT_ID=local-project\nVERTEX_LIVE_ADC_FILE=/nonexistent/local-credential.json\nVERTEX_LIVE_EXPECTED_ACCOUNT=local@example.invalid\n");
    await assert.rejects(loadConfiguration({ root, environment: { CI: "true" } }), /VERTEX_LIVE_PROJECT_ID/);
    const environment = { GITHUB_ACTIONS: "true", VERTEX_LIVE_PROJECT_ID: "ci-project", GOOGLE_APPLICATION_CREDENTIALS: generated };
    const configuration = await loadConfiguration({ root, environment });
    assert.equal(configuration.project, "ci-project");
    assert.equal(configuration.adcFile, generated);
    assert.equal(configuration.expectedAccount, "");
    await assert.rejects(loadConfiguration({ root, environment: { ...environment, VERTEX_LIVE_ADC_FILE: "/nonexistent/stale-file.json" } }), /CI ADC overrides conflict/);
    await assert.rejects(loadConfiguration({ root, environment, values: { "adc-file": "/nonexistent/stale-file.json" } }), /CI ADC overrides conflict/);
});

test("a generated ADC environment file overrides lower-priority dotenv credentials even outside CI", async (t) => {
    const root = await fixture(t);
    const credential = path.join(root, "generated fixture.json");
    await fs.writeFile(credential, "noncredential fixture");
    await fs.writeFile(path.join(root, ".env"), "VERTEX_LIVE_PROJECT_ID=fixture-project\nVERTEX_LIVE_ADC_FILE=/nonexistent/old-file.json\n");
    const configuration = await loadConfiguration({ root, environment: { GOOGLE_APPLICATION_CREDENTIALS: credential } });
    assert.equal(configuration.adcFile, credential);
    assert.equal(await fs.readFile(credential, "utf8"), "noncredential fixture");
});

test("dotenv handles quoted paths but cannot inject executable settings or expand shell code", async (t) => {
    const root = await fixture(t);
    const credential = path.join(root, "credentials # with spaces.json");
    await fs.writeFile(credential, "noncredential fixture");
    await fs.writeFile(path.join(root, ".env"), `VERTEX_LIVE_PROJECT_ID=fixture-project\nVERTEX_LIVE_ADC_FILE="${credential}" # comment\nNODE_OPTIONS="--require /untrusted.cjs"\nGOOGLE_VERTEX_BASE_URL=http://localhost/fake\nVERTEX_LIVE_CLAUDE_MODEL='literal-$(echo test)-$HOME'\n`);
    const configuration = await loadConfiguration({ root, environment: {} });
    assert.equal(configuration.adcFile, credential);
    assert.equal(configuration.models.claude, "literal-$(echo test)-$HOME");
    assert.equal(configuration.NODE_OPTIONS, undefined);
    assert.equal(configuration.GOOGLE_VERTEX_BASE_URL, undefined);
    assert.deepEqual((await fs.readdir(root)).sort(), [
        ".env",
        "credentials # with spaces.json",
    ]);
});

test("missing or invalid environment settings fail before any authentication", async (t) => {
    const root = await fixture(t);
    await assert.rejects(loadConfiguration({ root, environment: {} }), /VERTEX_LIVE_PROJECT_ID/);
    for (const value of [
        "",
        "-1",
        "90seconds",
        "0",
        "3601",
    ]) {
        await assert.rejects(loadConfiguration({ root, environment: { VERTEX_LIVE_PROJECT_ID: "fixture-project", VERTEX_LIVE_REQUEST_TIMEOUT_SECONDS: value } }), /integer|between/);
    }
    const configuration = await loadConfiguration({ root, environment: { VERTEX_LIVE_PROJECT_ID: "fixture-project" } });
    assert.equal(configuration.project, "fixture-project");
});

test("live defaults select supported Gemini and Claude models and obsolete Grok settings are ignored", async (t) => {
    const root = await fixture(t);
    const configuration = await loadConfiguration({ root, environment: { VERTEX_LIVE_PROJECT_ID: "fixture-project", VERTEX_LIVE_GROK_MODEL: "" } });
    assert.deepEqual(configuration.models, { gemini: "gemini-3.8-flash", claude: "claude-haiku-5-5" });
    const catalog = require("../src/models.json");
    for (const [
        provider,
        id,
    ] of Object.entries(configuration.models)) {
        const model = catalog.candidateModels.find((candidate) => candidate.id === id);
        assert.ok(model, "A default must exist in the packaged catalog");
        assert.equal(model.family, provider);
        assert.ok(model.capabilities.toolCalling && model.capabilities.imageInput);
    }
    await assert.rejects(loadConfiguration({ root, environment: { VERTEX_LIVE_PROJECT_ID: "fixture-project", VERTEX_LIVE_CLAUDE_MODEL: "" } }), /nonempty model ID/);
});

test("CI reports preserve acceptance evidence while redacting configured private values and leaving local reports intact", () => {
    const configuration = { project: "private-project", expectedAccount: "user@example.invalid", adcFile: "C:\\private\\credentials.json" };
    const report = {
        releaseEligible: false,
        configuration,
        authentication: { email: configuration.expectedAccount, identityVerified: true },
        checks: [{ provider: "claude", feature: "image", status: "failed", error: `Failure for ${configuration.project}, ${configuration.expectedAccount}, ${configuration.adcFile}` }],
        artifact: { sha256: "fixture-hash" },
    };
    const result = publicReport(report, configuration);
    for (const value of Object.values(configuration)) assert.equal(JSON.stringify(result).includes(value), false);
    assert.equal(result.authentication.identityVerified, true);
    assert.equal(result.checks[0].status, "failed");
    assert.equal(result.artifact.sha256, "fixture-hash");
    assert.equal(report.configuration.project, "private-project");
    assert.equal(report.authentication.email, "user@example.invalid");
});
