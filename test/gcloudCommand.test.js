const assert = require("node:assert/strict");
const Module = require("node:module");
const test = require("node:test");

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "vscode") {
    return {};
  }
  return originalLoad.call(this, request, parent, isMain);
};

let AuthManager;
try {
  ({ AuthManager } = require("../out/AuthManager.js"));
} finally {
  Module._load = originalLoad;
}

test("invokes gcloud directly on POSIX platforms", () => {
  assert.deepEqual(AuthManager.getGcloudAccountCommand("linux"), {
    executable: "gcloud",
    args: ["config", "get-value", "account"],
  });
});

test("invokes the Windows gcloud launcher through cmd.exe", () => {
  assert.deepEqual(AuthManager.getGcloudAccountCommand("win32", "C:\\Windows\\System32\\cmd.exe"), {
    executable: "C:\\Windows\\System32\\cmd.exe",
    args: ["/d", "/s", "/c", "gcloud.cmd config get-value account"],
  });
});

test("falls back to cmd.exe when ComSpec is unavailable", () => {
  assert.equal(AuthManager.getGcloudAccountCommand("win32", undefined).executable, "cmd.exe");
});
