const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const test = require("node:test");

class EventEmitter {
    listeners = new Set();
    event = (listener) => {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
    };
    fire() {
        for (const listener of this.listeners) listener();
    }
}

let quickPick;
let gcloudResult;
let commands;
let terminal;
const shellListeners = new Set();
const closeListeners = new Set();
const subscribe = (listeners, listener) => {
    listeners.add(listener);
    return { dispose: () => listeners.delete(listener) };
};
const vscode = {
    EventEmitter,
    QuickPickItemKind: { Separator: -1 },
    ThemeIcon: class {},
    window: {
        showQuickPick: async () => quickPick,
        showWarningMessage: async () => "Remove",
        showInformationMessage() {},
        showErrorMessage() {},
        createTerminal: () =>
            (terminal = {
                show() {},
                sendText(command) {
                    this.command = command;
                },
            }),
        onDidEndTerminalShellExecution: (listener) => subscribe(shellListeners, listener),
        onDidCloseTerminal: (listener) => subscribe(closeListeners, listener),
    },
};

let current, credentialModule, GatewayError;
const originalLoad = Module._load;
try {
    Module._load = function (request, parent, main) {
        if (request === "vscode") return vscode;
        if (request.endsWith("/Logger"))
            return {
                Logger: class {
                    log() {}
                },
            };
        if (request.endsWith("/utils/gcloud")) {
            return {
                runGcloud: async (args) => {
                    commands.push(args);
                    return { stdout: typeof gcloudResult === "function" ? await gcloudResult(args) : gcloudResult, stderr: "" };
                },
            };
        }
        return originalLoad.call(this, request, parent, main);
    };
    current = require("../out/auth/AuthManager.js");
    credentialModule = require("../out/auth/DirectGcpAuth.js");
    ({ GatewayError } = require("../out/ProxyGateway.js"));
} finally {
    Module._load = originalLoad;
}
const { AuthManager, AuthConfigurationError } = current;
const authKey = "vertexAiChat.activeAuthMethod";
const namesKey = "vertexAiChat.serviceAccountNames";
const credentials = (email = "selected@example.iam.gserviceaccount.com") => ({ type: "service_account", project_id: "fixture-project", client_email: email, private_key: "fixture-key" });
const jwt = (email = "proxy@example.com") => `header.${Buffer.from(JSON.stringify({ email, email_verified: true, exp: Date.now() / 1000 + 3600 })).toString("base64url")}.signature`;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vertex-auth-test-"));
const credentialFile = path.join(tempDir, "service-account.json");
const malformedFile = path.join(tempDir, "malformed.json");
fs.writeFileSync(credentialFile, JSON.stringify(credentials("ambient@example.iam.gserviceaccount.com")));
fs.writeFileSync(malformedFile, "invalid-json");
const originalCredentialPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
const deferred = () => {
    let resolve;
    const promise = new Promise((r) => {
        resolve = r;
    });
    return { promise, resolve };
};
const flush = () => new Promise(setImmediate);
function harness(method, secrets = {}) {
    const workspace = new Map([
        [
            authKey,
            method,
        ],
    ]);
    const global = new Map([
        [
            namesKey,
            Object.keys(secrets),
        ],
    ]);
    const stored = new Map(
        Object.entries(secrets).map(
            ([
                name,
                value,
            ]) => [
                "sa_key_" + name,
                value,
            ],
        ),
    );
    const memento = (values) => ({ get: (key) => values.get(key), update: async (key, value) => values.set(key, value) });
    const context = {
        workspaceState: memento(workspace),
        globalState: memento(global),
        secrets: { get: async (key) => stored.get(key), delete: async (key) => stored.delete(key) },
    };
    return { auth: new AuthManager(context), context, stored, global };
}

test.beforeEach(() => {
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    quickPick = undefined;
    gcloudResult = "cli@example.com";
    commands = [];
    terminal = undefined;
    shellListeners.clear();
    closeListeners.clear();
});
test.afterEach(() => {
    if (originalCredentialPath === undefined) delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    else process.env.GOOGLE_APPLICATION_CREDENTIALS = originalCredentialPath;
});
test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

test("the manager exposes the credential error constructor used by direct authentication", () => {
    assert.equal(current.AuthConfigurationError, credentialModule.AuthConfigurationError);
});

test("unavailable or invalid selected secrets never use ambient credentials", async (t) => {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = credentialFile;
    for (const [
        name,
        method,
        secret,
    ] of [
        [
            "missing name",
            { type: "secret" },
            undefined,
        ],
        [
            "missing secret",
            { type: "secret", value: "selected" },
            undefined,
        ],
        [
            "malformed JSON",
            { type: "secret", value: "selected" },
            "invalid-json",
        ],
        [
            "wrong credential type",
            { type: "secret", value: "selected" },
            JSON.stringify({ type: "authorized_user" }),
        ],
        [
            "missing key",
            { type: "secret", value: "selected" },
            JSON.stringify({ ...credentials(), private_key: "" }),
        ],
    ]) {
        await t.test(name, async () => {
            const { auth } = harness(method, secret === undefined ? {} : { selected: secret });
            await assert.rejects(auth.getResolvedAuthOptions(), AuthConfigurationError);
            await assert.rejects(auth.getIdentity(), AuthConfigurationError);
            assert.equal(commands.length, 0);
        });
    }
});

test("selected Service Account options and label identity stay independent of proxy authentication", async () => {
    const selected = credentials();
    const { auth } = harness({ type: "secret", value: "selected" }, { selected: JSON.stringify(selected) });
    gcloudResult = jwt();
    assert.deepEqual(await auth.getResolvedAuthOptions(), { credentials: selected, projectId: selected.project_id });
    assert.equal(await auth.getProxyIdToken(), gcloudResult);
    assert.equal(await auth.getIdentity(), selected.client_email);
    assert.equal(commands.length, 1);
    assert.ok(commands[0].includes("print-identity-token"));
});

test("proxy authentication works when an explicitly selected direct credential is unavailable", async () => {
    const { auth } = harness({ type: "secret", value: "missing" });
    gcloudResult = jwt();
    assert.equal(await auth.getProxyIdToken(), gcloudResult);
    await assert.rejects(auth.getResolvedAuthOptions(), AuthConfigurationError);
});

test("environment credential resolution is used only when no method is selected", async () => {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = credentialFile;
    const { auth } = harness(undefined);
    assert.equal((await auth.getResolvedAuthOptions()).keyFilename, credentialFile);
    assert.equal(await auth.getIdentity(), "ambient@example.iam.gserviceaccount.com");
    assert.equal(await harness({ type: "adc" }).auth.getResolvedAuthOptions(), undefined);
    process.env.GOOGLE_APPLICATION_CREDENTIALS = malformedFile;
    assert.equal(await harness(undefined).auth.getResolvedAuthOptions(), undefined);
});

test("explicit legacy files fail closed while readable legacy files still resolve", async () => {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = credentialFile;
    for (const value of [
        undefined,
        malformedFile,
        path.join(tempDir, "missing.json"),
    ]) {
        await assert.rejects(harness({ type: "file", value }).auth.getResolvedAuthOptions(), AuthConfigurationError);
    }
    assert.equal((await harness({ type: "file", value: credentialFile }).auth.getResolvedAuthOptions()).keyFilename, credentialFile);
});

test("selection changes invalidate pending identity lookups before notifying subscribers", async () => {
    const old = deferred();
    const { auth, context } = harness({ type: "secret", value: "old" }, { old: JSON.stringify(credentials("old@example.com")), next: JSON.stringify(credentials("next@example.com")) });
    const getSecret = context.secrets.get;
    let nextReads = 0;
    context.secrets.get = async (key) => {
        if (key === "sa_key_old") return old.promise;
        nextReads++;
        return getSecret(key);
    };
    const pendingIdentity = auth.getIdentity();
    let identityAtNotification;
    auth.onAuthUpdated(() => {
        identityAtNotification = auth.getIdentity();
    });
    quickPick = { label: "$(key) next" };
    assert.equal(await auth.selectAuthMethod(), true);
    assert.equal(await identityAtNotification, "next@example.com");
    old.resolve(JSON.stringify(credentials("old@example.com")));
    assert.equal(await pendingIdentity, undefined);
    assert.equal(await auth.getIdentity(), "next@example.com");
    assert.equal(nextReads, 1);
});

test("auth-change subscribers can invalidate a proxy acquisition already in progress", async () => {
    const { auth } = harness({ type: "adc" });
    const entered = deferred(),
        oldToken = deferred();
    gcloudResult = () => {
        entered.resolve();
        return oldToken.promise;
    };
    const rejected = assert.rejects(auth.getProxyIdToken(), GatewayError);
    await entered.promise;
    auth.onAuthUpdated(() => auth.clearProxyToken());
    await auth.clearAuthMethod();
    oldToken.resolve(jwt("old@example.com"));
    await rejected;
    gcloudResult = jwt("next@example.com");
    assert.equal(await auth.getProxyIdToken(), gcloudResult);
    assert.equal(commands.length, 2);
});

for (const removeActive of [
    false,
    true,
]) {
    test(`removing ${removeActive ? "the active" : "an inactive"} credential preserves workspace selection and notification semantics`, async () => {
        const { auth, stored, global } = harness({ type: "secret", value: "active" }, { active: JSON.stringify(credentials()), inactive: JSON.stringify(credentials("inactive@example.com")) });
        let updates = 0;
        auth.onAuthUpdated(() => {
            updates++;
        });
        quickPick = removeActive ? "active" : "inactive";
        assert.equal(await auth.removeServiceAccount(), removeActive);
        assert.equal(stored.has("sa_key_" + quickPick), false);
        assert.equal(global.get(namesKey).includes(quickPick), false);
        assert.deepEqual(auth.getActiveMethod(), removeActive ? { type: "adc" } : { type: "secret", value: "active" });
        assert.equal(updates, removeActive ? 1 : 0);
    });
}

for (const exitCode of [
    0,
    1,
]) {
    test(`ADC terminal login with exit code ${exitCode} activates ADC and refreshes only on success`, async () => {
        const { auth } = harness({ type: "secret", value: "selected" }, { selected: JSON.stringify(credentials()) });
        let refreshed = 0,
            updates = 0;
        auth.onAuthUpdated(() => {
            updates++;
        });
        await auth.reauthenticate("fixture-project", () => {
            refreshed++;
        });
        assert.equal(auth.getActiveMethod().type, "secret");
        assert.equal(terminal.command, "gcloud auth application-default login --project fixture-project --quiet");
        for (const listener of shellListeners) listener({ terminal, execution: { commandLine: { value: terminal.command } }, exitCode });
        await flush();
        assert.equal(auth.getActiveMethod().type, exitCode === 0 ? "adc" : "secret");
        assert.equal(refreshed, exitCode === 0 ? 1 : 0);
        assert.equal(updates, exitCode === 0 ? 1 : 0);
        assert.equal(shellListeners.size, 0);
        assert.equal(closeListeners.size, 0);
    });
}
