const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { spawn, execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { parseArgs } = require("node:util");
const { GoogleAuth, OAuth2Client } = require("google-auth-library");
const { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath } = require("@vscode/test-electron");
const { safeError, blockPending, completeReport } = require("../test/live/support.cjs");
const { loadConfiguration, publicReport, isCi } = require("../test/live/configuration.cjs");

const repository = path.resolve(__dirname, "..");
const defaultDirectory = path.join(repository, ".vscode-test", "live");
const options = {
    help: { type: "boolean" },
    "env-file": { type: "string" },
    project: { type: "string" },
    "expected-account": { type: "string" },
    "adc-file": { type: "string" },
    region: { type: "string" },
    "gemini-model": { type: "string" },
    "claude-model": { type: "string" },
    "vscode-version": { type: "string" },
    "vscode-executable": { type: "string" },
    vsix: { type: "string" },
    report: { type: "string" },
};

async function configurationFromArgs() {
    const { values } = parseArgs({ options, strict: true });
    if (values.help) {
        console.log(
            "Usage: npm run test:live -- --project PROJECT [--expected-account EMAIL] [--adc-file FILE]\nConfiguration: .env locally, injected environment in CI\nOptions: " +
                Object.keys(options)
                    .map((key) => `--${key}`)
                    .join(" ") +
                "\nSee docs/live-acceptance.md. All six Gemini/Claude checks are mandatory.",
        );
        return;
    }
    return loadConfiguration({ values, root: repository });
}

function childEnvironment(configuration) {
    const environment = { ...process.env };
    // Ensure SDKs cannot redirect acceptance requests to inherited local/mock endpoints.
    for (const key of [
        "ELECTRON_RUN_AS_NODE",
        "NODE_OPTIONS",
        "GOOGLE_VERTEX_BASE_URL",
        "GOOGLE_GEMINI_BASE_URL",
        "ANTHROPIC_VERTEX_BASE_URL",
        "GOOGLE_API_KEY",
        "GEMINI_API_KEY",
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
        "OPENAI_BASE_URL",
        "ANTHROPIC_AUTH_TOKEN",
        "VERTEX_LIVE_BOOTSTRAP_ONLY",
    ])
        delete environment[key];
    if (configuration.adcFile) environment.GOOGLE_APPLICATION_CREDENTIALS = configuration.adcFile;
    environment.GOOGLE_CLOUD_QUOTA_PROJECT = configuration.project;
    return environment;
}

async function supervised(executable, args, environment, logPath, seconds) {
    const log = await fs.open(logPath, "a", 0o600);
    try {
        await new Promise((resolve, reject) => {
            const child = spawn(executable, args, {
                cwd: repository,
                env: environment,
                detached: process.platform !== "win32",
                stdio: [
                    "ignore",
                    log.fd,
                    log.fd,
                ],
                shell: process.platform === "win32" && executable.endsWith(".cmd"),
            });
            let failure;
            let killTimer;
            const terminate = (force = false) => {
                if (!child.pid) return;
                try {
                    if (process.platform === "win32") {
                        execFileSync(
                            "taskkill",
                            [
                                "/pid",
                                String(child.pid),
                                "/T",
                                "/F",
                            ],
                            { stdio: "ignore" },
                        );
                    } else process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
                } catch {}
            };
            const stop = (reason) => {
                failure = new Error(reason);
                terminate();
                killTimer = setTimeout(() => terminate(true), 3000);
            };
            const interrupt = () => stop("Live test interrupted; the isolated host was terminated.");
            const timer = setTimeout(() => stop(`Process exceeded ${seconds}s; the isolated process group was terminated.`), seconds * 1000);
            process.once("SIGINT", interrupt);
            process.once("SIGTERM", interrupt);
            const cleanup = () => {
                clearTimeout(timer);
                clearTimeout(killTimer);
                process.removeListener("SIGINT", interrupt);
                process.removeListener("SIGTERM", interrupt);
            };
            child.once("error", (error) => {
                cleanup();
                reject(error);
            });
            child.once("close", (code) => {
                if (failure) terminate(true);
                cleanup();
                if (failure || code !== 0) reject(failure || new Error(`Process exited with code ${code}. Read the private log at ${logPath}.`));
                else resolve();
            });
        });
    } finally {
        await log.close();
    }
}

async function verifyAdc(configuration) {
    const controller = new AbortController();
    let timer;
    try {
        return await Promise.race([
            inspectAdc(configuration, controller.signal),
            new Promise((_, reject) => {
                timer = setTimeout(() => {
                    controller.abort();
                    reject(new Error("ADC preflight exceeded 45s. No model inference was attempted."));
                }, 45_000);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

async function inspectAdc(configuration, signal) {
    const auth = new GoogleAuth({
        projectId: configuration.project,
        ...(configuration.adcFile || process.env.GOOGLE_APPLICATION_CREDENTIALS ? { keyFilename: configuration.adcFile || process.env.GOOGLE_APPLICATION_CREDENTIALS } : {}),
        scopes: [
            "https://www.googleapis.com/auth/cloud-platform",
            "https://www.googleapis.com/auth/userinfo.email",
        ],
        clientOptions: { transporterOptions: { timeout: 30_000, signal } },
    });
    const client = await auth.getClient();
    const access = await client.getAccessToken();
    if (!access.token) throw new Error("ADC did not supply an access token.");
    const result = { method: "adc", source: configuration.adcFile || process.env.GOOGLE_APPLICATION_CREDENTIALS ? "credential file referenced in place" : "SDK ambient ADC", clientType: client.constructor.name, identityVerified: false };
    if (configuration.expectedAccount) {
        const oauth = new OAuth2Client({ transporterOptions: { timeout: 30_000, signal } });
        let info = await oauth.getTokenInfo(access.token);
        if (!info.email && !info.scopes?.some((scope) => scope === "email" || scope === "https://www.googleapis.com/auth/userinfo.email")) {
            throw new Error("ADC lacks the userinfo.email scope required to verify expectedAccount. Use a separate ADC file with Cloud Platform and email scopes; no inference was attempted.");
        }
        if (!info.email) {
            const response = await oauth.transporter.request({ url: "https://openidconnect.googleapis.com/v1/userinfo", headers: { Authorization: `Bearer ${access.token}` }, timeout: 30_000, signal });
            info = response.data;
        }
        if (!info.email) throw new Error("ADC token identity has no verifiable email. Select an ADC file with email scope or renew local ADC; no inference was attempted.");
        if (info.email.toLowerCase() !== configuration.expectedAccount.toLowerCase()) throw new Error(`ADC identity does not match expectedAccount (${configuration.expectedAccount}). Select the intended ADC file; no inference was attempted.`);
        result.identityVerified = true;
        result.email = info.email;
    }
    return result;
}

async function main() {
    const configuration = await configurationFromArgs();
    if (!configuration) return;
    await fs.mkdir(defaultDirectory, { recursive: true });
    const reportPath = path.resolve(configuration.report || path.join(defaultDirectory, "latest.json"));
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    const privateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "vertex-live-"));
    const hostReportPath = path.join(privateDirectory, "report.json");
    const logPath = path.join(privateDirectory, "process.log");
    const artifactPath = path.resolve(configuration.vsix || path.join(defaultDirectory, "artifact.vsix"));
    let source;
    try {
        source = {
            sha: execFileSync(
                "git",
                [
                    "rev-parse",
                    "HEAD",
                ],
                { cwd: repository, encoding: "utf8" },
            ).trim(),
            dirty: Boolean(
                execFileSync(
                    "git",
                    [
                        "status",
                        "--porcelain",
                    ],
                    { cwd: repository, encoding: "utf8" },
                ).trim(),
            ),
            provenance: configuration.vsix ? "external artifact; checkout metadata does not establish artifact source" : "packaged from this working tree",
        };
    } catch {
        source = { provenance: "source metadata unavailable" };
    }
    let report = {
        schemaVersion: 1,
        startedAt: new Date().toISOString(),
        status: "running",
        releaseEligible: false,
        source,
        ...(process.env.GITHUB_ACTIONS === "true" ? { ci: { runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT } } : {}),
        configuration: { project: configuration.project, expectedAccount: configuration.expectedAccount, region: configuration.region, models: configuration.models },
        checks: [],
    };
    const persist = async () => {
        await fs.writeFile(hostReportPath, JSON.stringify(report, null, 4), { mode: 0o600 });
        await fs.writeFile(reportPath, JSON.stringify(isCi(process.env) ? publicReport(report, configuration) : report, null, 4), { mode: 0o600 });
    };
    await persist();
    console.log(`Live test project: ${isCi(process.env) ? "[configured by CI]" : configuration.project}\nReport: ${reportPath}`);
    const environment = childEnvironment(configuration);
    try {
        console.log("Checking ADC before any model requests...");
        report.authentication = await verifyAdc(configuration);
        await persist();
        if (!configuration.vsix) {
            console.log("Packaging the extension...");
            await supervised(
                process.execPath,
                [
                    path.join(repository, "node_modules", "@vscode", "vsce", "vsce"),
                    "package",
                    "--no-dependencies",
                    "--out",
                    artifactPath,
                ],
                environment,
                logPath,
                180,
            );
        }
        report.artifact = {
            path: artifactPath,
            sha256: createHash("sha256")
                .update(await fs.readFile(artifactPath))
                .digest("hex"),
        };
        await persist();
        const executable = configuration.vscodeExecutable ? path.resolve(configuration.vscodeExecutable) : await downloadAndUnzipVSCode({ version: configuration.vscodeVersion, cachePath: path.join(repository, ".vscode-test"), timeout: 120_000 });
        const userData = path.join(privateDirectory, "profile");
        const extensions = path.join(privateDirectory, "extensions");
        const workspace = path.join(privateDirectory, "workspace");
        const helper = path.join(privateDirectory, "test-extension");
        for (const directory of [
            path.join(userData, "User"),
            extensions,
            path.join(workspace, ".vscode"),
            helper,
        ])
            await fs.mkdir(directory, { recursive: true });
        await fs.writeFile(
            path.join(userData, "User", "settings.json"),
            JSON.stringify({
                "vertexAiChat.projectId": "",
                "vertexAiChat.proxyUrl": "",
                "vertexAiChat.enableUserLabel": false,
                "vertexAiChat.enableProjectLabel": false,
                "vertexAiChat.thinkingEffortByModel": {},
                "vertexAiChat.retryMaxDurationMinutes": 1,
                "vertexAiChat.modelDiscoveryTimeoutSeconds": 20,
                "security.workspace.trust.enabled": false,
                "telemetry.telemetryLevel": "off",
                "extensions.autoUpdate": false,
                "window.dialogStyle": "custom",
            }),
        );
        await fs.writeFile(path.join(helper, "package.json"), JSON.stringify({ name: "vertex-live-acceptance-harness", publisher: "vertex-tests", version: "1.0.0", engines: { vscode: "^1.110.0" }, main: "./extension.cjs", activationEvents: ["*"] }));
        await fs.writeFile(path.join(helper, "extension.cjs"), "exports.activate = () => {};\n");
        const profileArgs = [
            `--user-data-dir=${userData}`,
            `--extensions-dir=${extensions}`,
        ];
        const [
            cli,
            ...cliArgs
        ] = resolveCliArgsFromVSCodeExecutablePath(executable, { reuseMachineInstall: true });
        console.log("Installing the VSIX in the isolated profile...");
        await supervised(
            cli,
            [
                ...cliArgs,
                ...profileArgs,
                "--install-extension",
                artifactPath,
                "--force",
                "--do-not-sync",
            ],
            environment,
            logPath,
            120,
        );
        const hostEnvironment = { ...environment, VERTEX_LIVE_REPORT: hostReportPath, VERTEX_LIVE_CONFIGURATION: JSON.stringify(configuration), VERTEX_LIVE_REPOSITORY: repository, VERTEX_LIVE_EXTENSIONS: extensions };
        const args = [
            workspace,
            ...profileArgs,
            "--no-sandbox",
            "--disable-gpu",
            "--disable-gpu-sandbox",
            "--disable-updates",
            "--skip-welcome",
            "--skip-release-notes",
            "--disable-workspace-trust",
            "--no-cached-data",
            `--extensionDevelopmentPath=${helper}`,
            `--extensionTestsPath=${path.join(repository, "test", "live", "host.cjs")}`,
        ];
        const headless = process.platform === "linux" && !environment.DISPLAY;
        console.log("Running six live checks through the installed extension...");
        await supervised(
            headless ? "xvfb-run" : executable,
            headless
                ? [
                      "-a",
                      executable,
                      ...args,
                  ]
                : args,
            hostEnvironment,
            logPath,
            configuration.hostTimeoutSeconds,
        );
        report = JSON.parse(await fs.readFile(hostReportPath, "utf8"));
        assertArtifact(
            report.artifact.sha256,
            createHash("sha256")
                .update(await fs.readFile(artifactPath))
                .digest("hex"),
        );
        completeReport(report);
    } catch (error) {
        report = JSON.parse(await fs.readFile(hostReportPath, "utf8"));
        report.runnerError = safeError(error);
        report.releaseEligible = false;
        blockPending(report, report.runnerError);
        // A host/process failure cannot be overridden by individually passing assertions.
        report.status = "failed";
        report.releaseEligible = false;
        console.error((isCi(process.env) ? publicReport(report, configuration) : report).runnerError);
    }
    await persist();
    const visibleReport = isCi(process.env) ? publicReport(report, configuration) : report;
    for (const check of visibleReport.checks) console.log(`${check.status.toUpperCase().padEnd(7)} ${check.provider.padEnd(6)} ${check.feature}${check.error ? `: ${check.error}` : ""}`);
    console.log(`Release eligible: ${report.releaseEligible}\nPrivate host logs: ${privateDirectory}\nReport: ${reportPath}`);
    if (!report.releaseEligible) process.exitCode = 1;
}

function assertArtifact(expected, actual) {
    if (expected !== actual) throw new Error("VSIX changed during acceptance. The tested artifact hash no longer matches.");
}

if (require.main === module)
    main().catch((error) => {
        console.error(safeError(error));
        process.exitCode = 1;
    });

module.exports = { childEnvironment, supervised, assertArtifact };
