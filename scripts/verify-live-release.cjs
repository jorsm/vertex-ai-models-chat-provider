const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");

// Keep publication's required matrix independent of the live runner's constants.
const requiredChecks = [
    "gemini:chat",
    "gemini:tools",
    "gemini:image",
    "claude:chat",
    "claude:tools",
    "claude:image",
];

function requireProof(condition, message) {
    assert.ok(condition, `Release gate rejected: ${message}`);
}

function verifyReport(report, { vsix, expectedSourceSha, environment }) {
    requireProof(environment.GITHUB_ACTIONS === "true" && /^\d+$/.test(environment.GITHUB_RUN_ID || "") && /^\d+$/.test(environment.GITHUB_RUN_ATTEMPT || ""), "GitHub run identity is unavailable.");
    requireProof(report?.schemaVersion === 1, "unsupported or missing report schema.");
    requireProof(report.ci?.runId === environment.GITHUB_RUN_ID && report.ci?.runAttempt === environment.GITHUB_RUN_ATTEMPT, "report belongs to a different GitHub run or attempt.");
    requireProof(typeof expectedSourceSha === "string" && /^[a-f\d]{40}(?:[a-f\d]{24})?$/.test(expectedSourceSha) && report.source?.sha === expectedSourceSha, "report does not match the checked-out source commit.");
    requireProof(report.status === "passed" && report.releaseEligible === true && !report.runnerError, "live acceptance did not complete successfully.");
    requireProof(Number.isFinite(Date.parse(report.startedAt)) && Number.isFinite(Date.parse(report.completedAt)) && Date.parse(report.completedAt) >= Date.parse(report.startedAt), "report completion timestamps are missing or invalid.");
    requireProof(report.setup?.status === "passed" && !report.setup.bootstrapOnly, "full live setup did not pass.");
    requireProof(report.authentication?.method === "adc" && report.authentication.identityVerified === true, "ADC identity was not verified.");
    requireProof(report.host?.extensionMode === "production" && typeof report.host.version === "string" && report.host.version.length > 0 && typeof report.host.extensionVersion === "string" && report.host.extensionVersion.length > 0, "installed production extension proof is missing.");
    requireProof(report.catalog?.source === "seeded by installed extension", "model catalog was not read from the installed extension.");
    requireProof(typeof report.artifact?.path === "string" && path.isAbsolute(report.artifact.path) && path.resolve(report.artifact.path) === path.resolve(vsix), "report names a different VSIX artifact.");
    requireProof(typeof report.artifact.sha256 === "string" && /^[a-f\d]{64}$/.test(report.artifact.sha256), "artifact digest is missing or invalid.");

    requireProof(Array.isArray(report.checks) && report.checks.length === requiredChecks.length, "the six mandatory live checks are not all present.");
    const keys = report.checks.map((check) => `${check?.provider}:${check?.feature}`);
    requireProof(new Set(keys).size === requiredChecks.length && requiredChecks.every((key) => keys.includes(key)), "the mandatory provider and feature matrix is incomplete.");
    for (const check of report.checks) {
        requireProof(check.status === "passed" && !check.error, "a mandatory live check did not pass.");
        const model = report.configuration?.models?.[check.provider];
        requireProof(typeof model === "string" && model.length > 0 && check.model === model, "a check did not use its configured provider model.");
        const evidence = check.evidence;
        if (check.feature === "chat") {
            requireProof(typeof evidence?.reply === "string" && /^CHAT_[a-f\d]{16}$/.test(evidence.reply) && Number.isInteger(evidence.textParts) && evidence.textParts > 0, "live chat response proof is missing.");
        } else if (check.feature === "tools") {
            requireProof(
                evidence?.tool === "acceptance_add" && Number.isInteger(evidence.input?.left) && Number.isInteger(evidence.input?.right) && evidence.sum === evidence.input.left + evidence.input.right && typeof evidence.continuation === "string" && /^TOOL_[a-f\d]{24}$/.test(evidence.continuation),
                "live tool continuation proof is missing.",
            );
        } else {
            const colors = evidence?.expected?.split(",");
            requireProof(
                Array.isArray(colors) &&
                    colors.length === 5 &&
                    new Set(colors).size === 5 &&
                    colors.every((color) =>
                        [
                            "red",
                            "green",
                            "blue",
                            "yellow",
                            "purple",
                        ].includes(color),
                    ) &&
                    evidence.actual === evidence.expected &&
                    typeof evidence.imageSha256 === "string" &&
                    /^[a-f\d]{64}$/.test(evidence.imageSha256),
                "live image response proof is missing.",
            );
        }
    }
}

async function verifyReleaseArtifact({ vsix, report: reportPath, expectedSourceSha, environment = process.env }) {
    let report;
    try {
        report = JSON.parse(await fs.readFile(reportPath, "utf8"));
    } catch {
        throw new Error("Release gate rejected: live report could not be read.");
    }
    verifyReport(report, { vsix, expectedSourceSha, environment });
    let bytes;
    try {
        bytes = await fs.readFile(vsix);
    } catch {
        throw new Error("Release gate rejected: VSIX artifact could not be read.");
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    requireProof(sha256 === report.artifact.sha256, "VSIX bytes do not match the artifact tested live.");
    return { sha256 };
}

function parseArguments(arguments_) {
    const values = {};
    for (let index = 0; index < arguments_.length; index += 2) {
        const argument = arguments_[index];
        requireProof((argument === "--vsix" || argument === "--report") && !Object.hasOwn(values, argument) && typeof arguments_[index + 1] === "string" && !arguments_[index + 1].startsWith("--"), "use --vsix PATH --report PATH.");
        values[argument] = arguments_[index + 1];
    }
    requireProof(values["--vsix"] && values["--report"], "use --vsix PATH --report PATH.");
    return { vsix: path.resolve(values["--vsix"]), report: path.resolve(values["--report"]) };
}

async function main() {
    const paths = parseArguments(process.argv.slice(2));
    let expectedSourceSha;
    try {
        expectedSourceSha = execFileSync(
            "git",
            [
                "rev-parse",
                "HEAD",
            ],
            {
                encoding: "utf8",
                stdio: [
                    "ignore",
                    "pipe",
                    "ignore",
                ],
            },
        ).trim();
    } catch {
        throw new Error("Release gate rejected: checked-out source commit is unavailable.");
    }
    const { sha256 } = await verifyReleaseArtifact({ ...paths, expectedSourceSha });
    console.log(`Release gate passed for tested VSIX SHA256 ${sha256}.`);
}

if (require.main === module) {
    main().catch((error) => {
        // Only fixed guard messages reach public CI logs, never report contents.
        console.error(error.message?.startsWith("Release gate rejected:") ? error.message : "Release gate rejected: verification could not complete.");
        process.exitCode = 1;
    });
}

module.exports = { verifyReleaseArtifact };
