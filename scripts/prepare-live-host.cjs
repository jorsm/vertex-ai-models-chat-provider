const path = require("node:path");
const { downloadAndUnzipVSCode } = require("@vscode/test-electron");
const { DEFAULTS, safeError } = require("../test/live/support.cjs");

async function main() {
    const version = process.env.VERTEX_LIVE_VSCODE_VERSION ?? DEFAULTS.vscodeVersion;
    if (version.length > 30 || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(version)) throw new Error("VERTEX_LIVE_VSCODE_VERSION must be an explicit numeric version, such as 1.110.0.");
    await downloadAndUnzipVSCode({ version, cachePath: path.resolve(__dirname, "..", ".vscode-test"), timeout: 120_000 });
    console.log(`Prepared VS Code ${version} for live acceptance.`);
}

main().catch((error) => {
    console.error(safeError(error));
    process.exitCode = 1;
});
