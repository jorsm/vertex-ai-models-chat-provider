const assert = require("node:assert/strict");
const test = require("node:test");
const Module = require("node:module");
let user,
    workspace,
    fail = false;
const writes = [],
    resources = [];
const vscode = {
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    workspace: {
        workspaceFolders: [{}],
        getConfiguration: (_section, resource) => {
            resources.push(resource);
            return {
                get: () => ({ ...user, ...workspace }),
                inspect: () => ({ globalValue: user, workspaceValue: workspace }),
                update: async (key, value, target) => {
                    if (fail) throw Error("read-only");
                    writes.push({ key, value, target });
                    if (target === 1) user = value;
                    else workspace = value;
                },
            };
        },
    },
};
const load = Module._load;
let api;
try {
    Module._load = function (r, ...args) {
        return r === "vscode" ? vscode : load.call(this, r, ...args);
    };
    api = require("../out/effort/EffortConfiguration.js");
} finally {
    Module._load = load;
}
test.beforeEach(() => {
    user = {};
    workspace = {};
    fail = false;
    writes.length = 0;
    resources.length = 0;
    vscode.workspace.workspaceFolders = [{}];
});

test("Workspace wins per key, named Workspace choice overrides User; removal reveals User", async () => {
    user = { a: "high", b: "low" };
    workspace = { a: "medium" };
    assert.equal(api.captureEffortPreferences().preferences.a, "medium");
    assert.equal(api.captureEffortPreferences().preferences.b, "low");
    assert.equal(api.defaultEffortTarget("a"), 2);
    assert.equal(api.defaultEffortTarget("b"), 1);
    await api.writeEffortPreference("a", undefined, 2);
    assert.deepEqual(api.captureEffortPreferences().preferences, { a: "high", b: "low" });
    assert.equal(api.captureEffortPreferences().sourceByModel.a, "user");
    assert(resources.every((uri) => uri === undefined));
});
test("targeted writes preserve raw scope keys and re-read for serialized concurrent writes", async () => {
    user = { a: "high", unknown: "max" };
    workspace = { b: "low" };
    await Promise.all([api.writeEffortPreference("a", "max", 1), api.writeEffortPreference("c", "high", 1)]);
    assert.deepEqual(user, { a: "max", unknown: "max", c: "high" });
    assert.deepEqual(workspace, { b: "low" });
    await api.writeEffortPreference("a", "medium", 2);
    assert.deepEqual(workspace, { b: "low", a: "medium" });
});
test("invalid higher scope stays invalid; unrelated invalid values remain stored; snapshots detach", () => {
    user = { a: "high", unknown: "invalid" };
    workspace = { a: "invalid" };
    const captured = api.captureEffortPreferences();
    workspace.a = "low";
    user.unknown = "high";
    assert.equal(captured.preferences.a, "invalid");
    assert.equal(captured.preferences.unknown, "invalid");
    assert(Object.isFrozen(captured.preferences));
});
test("malformed shape reports configuration problem", () => {
    for (const value of [[], null, "high", 42]) {
        workspace = value;
        assert.throws(() => api.captureEffortPreferences(), /must be an object/);
    }
});
test("failed writes and unavailable workspace keep state unchanged; queue recovers", async () => {
    user = { a: "high" };
    fail = true;
    await assert.rejects(api.writeEffortPreference("a", "max", 1), /read-only/);
    assert.equal(user.a, "high");
    fail = false;
    await api.writeEffortPreference("a", "max", 1);
    assert.equal(user.a, "max");
    vscode.workspace.workspaceFolders = [];
    await assert.rejects(api.writeEffortPreference("a", "low", 2), /open workspace/);
    assert.deepEqual(workspace, {});
});
test("queued writes validate the current connection/catalog before persisting", async () => {
    await assert.rejects(
        api.writeEffortPreference("a", "max", 1, () => {
            throw Error("stale");
        }),
        /stale/,
    );
    assert.equal(writes.length, 0);
});
