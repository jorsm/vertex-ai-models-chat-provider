const assert = require("node:assert/strict");
const test = require("node:test");
const childProcess = require("node:child_process");
const { GCLOUD_DEFAULT_TIMEOUT_MS, formatGcloudCommand, resolveGcloudCommand, resolveGcloudTimeoutMs, runGcloud } = require("../out/utils/gcloud.js");

const bin = "C:\\SDK with spaces\\bin";
const python = "C:\\SDK with spaces\\platform\\bundledpython\\python.exe";
const script = "C:\\SDK with spaces\\lib\\gcloud.py";
const exists = (file) =>
    [
        bin + "\\gcloud.cmd",
        python,
        script,
    ].includes(file);
test("Windows uses bundled Python directly with separate arguments and no shell quoting", () => {
    assert.deepEqual(
        resolveGcloudCommand(
            [
                "auth",
                "print-identity-token",
            ],
            "win32",
            { PATH: bin },
            exists,
        ),
        {
            executable: python,
            args: [
                "-S",
                script,
                "auth",
                "print-identity-token",
            ],
            direct: true,
        },
    );
    assert.equal(
        formatGcloudCommand({
            executable: python,
            args: [
                "-S",
                script,
                "auth",
                "print-identity-token",
            ],
            direct: true,
        }),
        `"${python}" -S "${script}" auth print-identity-token`,
    );
});
test("explicit SDK interpreter options preserve the standard launcher", () => {
    for (const setting of [
        "CLOUDSDK_PYTHON",
        "CLOUDSDK_PYTHON_ARGS",
        "CLOUDSDK_USE_GOCLOUD",
    ]) {
        assert.equal(resolveGcloudCommand(["auth"], "win32", { PATH: bin, [setting]: "custom" }, exists).direct, false);
    }
    assert.equal(resolveGcloudCommand(["auth"], "win32", { PATH: bin }, () => false).direct, false);
});
test("gcloud probes close stdin immediately and kill a hung process at the deadline", async (t) => {
    const original = childProcess.execFile;
    t.after(() => {
        childProcess.execFile = original;
    });
    let closed = false,
        killed = false;
    childProcess.execFile = (executable, _args, _options, callback) => {
        if (executable === "taskkill.exe") {
            killed = true;
            callback(null, "", "");
            return {};
        }
        return {
            pid: 12345,
            stdin: {
                end() {
                    closed = true;
                },
            },
            kill() {
                killed = true;
            },
        };
    };
    await assert.rejects(
        runGcloud(
            [
                "auth",
                "print-identity-token",
            ],
            10,
        ),
        (error) => error.code === "GCLOUD_TIMEOUT",
    );
    assert.equal(closed, true);
    assert.equal(killed, true);
});
test("Windows launcher timeout kills the process tree before releasing the request", { skip: process.platform !== "win32" }, async (t) => {
    const original = childProcess.execFile;
    const pythonSetting = process.env.CLOUDSDK_PYTHON;
    process.env.CLOUDSDK_PYTHON = "custom-python";
    t.after(() => {
        childProcess.execFile = original;
        if (pythonSetting === undefined) delete process.env.CLOUDSDK_PYTHON;
        else process.env.CLOUDSDK_PYTHON = pythonSetting;
    });
    let cleanupCompleted = false;
    childProcess.execFile = (executable, args, options, callback) => {
        if (executable === "taskkill.exe") {
            assert.deepEqual(args, [
                "/pid",
                "12345",
                "/T",
                "/F",
            ]);
            setImmediate(() => {
                cleanupCompleted = true;
                callback(null, "", "");
            });
            return {};
        }
        assert.equal(options.timeout, undefined);
        return { pid: 12345, stdin: { end() {} } };
    };
    await assert.rejects(
        runGcloud(
            [
                "config",
                "get-value",
                "account",
            ],
            10,
        ),
        (error) => error.code === "GCLOUD_TIMEOUT",
    );
    assert.equal(cleanupCompleted, true);
});
test("gcloud timeout setting validates integer seconds and defaults to 20s", () => {
    for (const value of [
        undefined,
        0,
        -5,
        1.5,
        Number.NaN,
        "20",
        2_147_484,
    ]) {
        assert.equal(resolveGcloudTimeoutMs(value), GCLOUD_DEFAULT_TIMEOUT_MS);
    }
    assert.equal(resolveGcloudTimeoutMs(1), 1_000);
    assert.equal(resolveGcloudTimeoutMs(35), 35_000);
    assert.equal(resolveGcloudTimeoutMs(2_147_483), 2_147_483_000);
    const setting = require("../package.json").contributes.configuration.properties["vertexAiChat.gcloudCommandTimeoutSeconds"];
    assert.equal(setting.type, "integer");
    assert.equal(setting.default, 20);
    assert.equal(setting.minimum, 1);
    assert.equal(setting.maximum, 2_147_483);
});
