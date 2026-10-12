const assert = require("node:assert/strict");
const test = require("node:test");
const { resolveGcloudCommand } = require("../out/utils/gcloud.js");
const args = [
    "config",
    "get-value",
    "account",
];

test("invokes gcloud directly on POSIX platforms", () => {
    assert.deepEqual(resolveGcloudCommand(args, "linux"), {
        executable: "gcloud",
        args: [
            "config",
            "get-value",
            "account",
        ],
        direct: true,
    });
});

test("invokes the Windows gcloud launcher through cmd.exe", () => {
    assert.deepEqual(
        resolveGcloudCommand(args, "win32", { ComSpec: "C:\\Windows\\System32\\cmd.exe" }, () => false),
        {
            executable: "C:\\Windows\\System32\\cmd.exe",
            args: [
                "/d",
                "/s",
                "/c",
                "gcloud.cmd config get-value account",
            ],
            direct: false,
        },
    );
});

test("falls back to cmd.exe when ComSpec is unavailable", () => {
    assert.equal(resolveGcloudCommand(args, "win32", {}, () => false).executable, "cmd.exe");
});
