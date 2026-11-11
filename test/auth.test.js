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
let information, errors, logs, inputValues, inputOptions, selectedFiles;
const shellListeners = new Set();
const shellStartListeners = new Set();
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
        showQuickPick: async (items) => {
            if (typeof quickPick === "function") return quickPick(items);
            if (typeof quickPick === "string") return quickPick;
            return items.find((item) => item.label === quickPick?.label);
        },
        showWarningMessage: async () => "Remove",
        showInformationMessage: (message) => information.push(message),
        showErrorMessage: (message) => errors.push(message),
        showInputBox: async (options) => {
            inputOptions.push(options);
            return inputValues.shift();
        },
        showOpenDialog: async () => selectedFiles,
        createTerminal: () =>
            (terminal = {
                show() {},
                sendText(command) {
                    this.command = command;
                },
            }),
        onDidEndTerminalShellExecution: (listener) => subscribe(shellListeners, listener),
        onDidStartTerminalShellExecution: (listener) => subscribe(shellStartListeners, listener),
        onDidCloseTerminal: (listener) => subscribe(closeListeners, listener),
    },
    workspace: {
        name: "fixture-workspace",
        fs: { readFile: async (uri) => fs.promises.readFile(uri.fsPath) },
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
                    log(message) {
                        logs.push(message);
                    }
                },
            };
        if (request.endsWith("/utils/gcloud")) {
            return {
                ...originalLoad.call(this, request, parent, main),
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
const { getConfiguredGcloudTimeoutMs } = require("../out/auth/AuthCredentials.js");
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
        secrets: { get: async (key) => stored.get(key), store: async (key, value) => stored.set(key, value), delete: async (key) => stored.delete(key) },
    };
    return { auth: new AuthManager(context), context, stored, global };
}

test.beforeEach(() => {
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    quickPick = undefined;
    gcloudResult = "cli@example.com";
    commands = [];
    terminal = undefined;
    information = [];
    errors = [];
    logs = [];
    inputValues = [];
    inputOptions = [];
    selectedFiles = undefined;
    shellListeners.clear();
    shellStartListeners.clear();
    closeListeners.clear();
});
test.afterEach(() => {
    if (originalCredentialPath === undefined) delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    else process.env.GOOGLE_APPLICATION_CREDENTIALS = originalCredentialPath;
});
test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

test("gcloud timeout settings accept 1–300 integer seconds and otherwise use 20 seconds", (t) => {
    let seconds;
    vscode.workspace.getConfiguration = () => ({ get: () => seconds });
    t.after(() => {
        delete vscode.workspace.getConfiguration;
    });
    for (const value of [
        undefined,
        null,
        false,
        0,
        -5,
        1.5,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        "20",
        301,
        2_147_483,
    ]) {
        seconds = value;
        assert.equal(getConfiguredGcloudTimeoutMs(), 20_000);
    }
    for (const [
        value,
        expectedMs,
    ] of [
        [
            1,
            1_000,
        ],
        [
            35,
            35_000,
        ],
        [
            300,
            300_000,
        ],
    ]) {
        seconds = value;
        assert.equal(getConfiguredGcloudTimeoutMs(), expectedMs);
    }
    const setting = require("../package.json").contributes.configuration.properties["vertexAiChat.gcloudCommandTimeoutSeconds"];
    assert.equal(setting.type, "integer");
    assert.equal(setting.default, 20);
    assert.equal(setting.minimum, 1);
    assert.equal(setting.maximum, 300);
});

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

test("the manager suppresses ADC fallback logs for user or default proxy settings only", async (t) => {
    let proxySetting;
    vscode.workspace.getConfiguration = () => ({ inspect: () => proxySetting });
    t.after(() => {
        delete vscode.workspace.getConfiguration;
    });
    for (const [
        setting,
        shouldLog,
    ] of [
        [
            {},
            true,
        ],
        [
            { globalValue: "https://gateway.test" },
            false,
        ],
        [
            { defaultValue: "https://gateway.test" },
            false,
        ],
        [
            { globalValue: "   ", defaultValue: "" },
            true,
        ],
        [
            { workspaceValue: "https://workspace.test" },
            true,
        ],
    ]) {
        proxySetting = setting;
        for (const method of [
            undefined,
            { type: "adc" },
        ]) {
            logs.length = 0;
            assert.equal(await harness(method).auth.getResolvedAuthOptions(), undefined);
            assert.equal(
                logs.some((message) => message.includes("Application Default Credentials (ADC)")),
                shouldLog,
            );
        }
    }
    assert.equal(commands.length, 0);
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

test("stored credential names containing action labels still select the credential", async () => {
    const name = "gcloud login and Import Service Account";
    const { auth } = harness({ type: "adc" }, { [name]: JSON.stringify(credentials()) });
    quickPick = { label: `$(key) ${name}` };
    assert.equal(await auth.selectAuthMethod(), true);
    assert.deepEqual(auth.getActiveMethod(), { type: "secret", value: name });
});

test("picker actions remain valid when display labels change and separators cannot select auth", async () => {
    const { auth } = harness({ type: "adc" }, { selected: JSON.stringify(credentials()) });
    quickPick = (items) => ({ ...items.find((item) => item.action?.type === "secret"), label: "Renamed display label" });
    assert.equal(await auth.selectAuthMethod(), true);
    assert.deepEqual(auth.getActiveMethod(), { type: "secret", value: "selected" });
    quickPick = { label: "Stored Secrets" };
    assert.equal(await auth.selectAuthMethod(), false);
    assert.deepEqual(auth.getActiveMethod(), { type: "secret", value: "selected" });
});

test("credential paste validates without exposing JSON fragments and rejects blank stored names", async () => {
    const { auth, stored } = harness({ type: "adc" });
    inputValues = [
        JSON.stringify(credentials()),
        "   ",
    ];
    assert.equal(await auth.setServiceAccountKey(), false);
    assert.equal(inputOptions[0].password, true);
    const validation = inputOptions[0].validateInput('{"private_key":"fixture-secret-fragment"');
    assert.match(validation, /Invalid JSON/);
    assert.ok(!validation.includes("fixture-secret-fragment"));
    assert.equal(stored.size, 0);
    assert.deepEqual(auth.getActiveMethod(), { type: "adc" });
});

test("imported credentials remain a stored snapshot when the source file changes", async () => {
    const sourceFile = path.join(tempDir, "imported.json");
    const original = credentials("imported@example.iam.gserviceaccount.com");
    fs.writeFileSync(sourceFile, JSON.stringify(original));
    selectedFiles = [{ fsPath: sourceFile }];
    inputValues = ["imported"];
    const { auth, stored } = harness({ type: "adc" });
    assert.equal(await auth.importServiceAccountFile(), true);
    fs.writeFileSync(sourceFile, JSON.stringify(credentials("changed@example.iam.gserviceaccount.com")));
    assert.deepEqual(await auth.getResolvedAuthOptions(), { credentials: original, projectId: original.project_id });
    assert.equal(stored.get("sa_key_imported"), JSON.stringify(original));
});

test("credential files preserve authorized-user formats and reject non-object JSON", async () => {
    const file = path.join(tempDir, "other-credentials.json");
    const authorizedUser = { type: "authorized_user", client_id: "fixture-client", refresh_token: "fixture-refresh" };
    fs.writeFileSync(file, JSON.stringify(authorizedUser));
    const { auth } = harness({ type: "file", value: file });
    assert.deepEqual(await auth.getResolvedAuthOptions(), { keyFilename: file, credentials: authorizedUser });
    assert.equal(await auth.getIdentity(), "cli@example.com");
    for (const invalid of [
        "null",
        "[]",
        "42",
        '"fixture-string"',
    ]) {
        fs.writeFileSync(file, invalid);
        await assert.rejects(harness({ type: "file", value: file }).auth.getResolvedAuthOptions(), AuthConfigurationError);
        process.env.GOOGLE_APPLICATION_CREDENTIALS = file;
        assert.equal(await harness(undefined).auth.getResolvedAuthOptions(), undefined);
    }
});

test("expired identity cache survives a CLI failure but clears an explicitly unset account", async (t) => {
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    t.after(() => {
        Date.now = realNow;
    });
    const { auth } = harness({ type: "adc" });
    assert.equal(await auth.getIdentity(), "cli@example.com");
    now += 60_001;
    gcloudResult = () => {
        throw new Error("Fixture CLI failure");
    };
    assert.equal(await auth.getIdentity(), "cli@example.com");
    gcloudResult = "(unset)";
    assert.equal(await auth.getIdentity(), undefined);
    assert.equal(commands.length, 3);
});

test("an authentication change stops identity timeout retries and a later lookup uses the new revision", async () => {
    const { auth } = harness({ type: "adc" });
    let attempts = 0;
    gcloudResult = async () => {
        attempts++;
        await auth.clearAuthMethod();
        throw Object.assign(new Error("Fixture timeout"), { code: "GCLOUD_TIMEOUT", killed: true });
    };
    assert.equal(await auth.getIdentity(), undefined);
    assert.equal(attempts, 1);
    gcloudResult = "current@example.com";
    assert.equal(await auth.getIdentity(), "current@example.com");
    assert.equal(await auth.getIdentity(), "current@example.com");
    assert.equal(commands.length, 2);
});

test("a failed identity lookup releases the shared CLI queue for proxy token acquisition", async () => {
    const { auth } = harness({ type: "adc" });
    const entered = deferred(),
        release = deferred();
    const expected = jwt();
    gcloudResult = async (args) => {
        if (args[0] === "config") {
            entered.resolve();
            await release.promise;
            throw Object.assign(new Error("Fixture executable missing"), { code: "ENOENT" });
        }
        return expected;
    };
    const identity = auth.getIdentity();
    await entered.promise;
    const token = auth.getProxyIdToken();
    await flush();
    assert.equal(commands.length, 1);
    release.resolve();
    assert.equal(await identity, undefined);
    assert.equal(await token, expected);
    assert.deepEqual(
        commands.map((args) => args[0]),
        [
            "config",
            "auth",
        ],
    );
});

test("invalid claim shapes and overflowing expiration fail with sanitized proxy errors", async () => {
    const { auth } = harness({ type: "adc" });
    for (const claims of [
        "null",
        "[]",
        '"fixture-string"',
        '{"email":"fixture@example.com","email_verified":true,"exp":1e400}',
    ]) {
        gcloudResult = `header.${Buffer.from(claims).toString("base64url")}.signature`;
        await assert.rejects(auth.getProxyIdToken(), (error) => error instanceof GatewayError && error.status === 401 && !error.message.includes(claims));
        assert.ok(logs.every((message) => !message.includes(gcloudResult)));
    }
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
    undefined,
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
        assert.equal(shellStartListeners.size, 0);
        assert.equal(closeListeners.size, 0);
    });
}

test("proxy terminal login uses gcloud auth login without changing direct auth selection", async (t) => {
    vscode.workspace.getConfiguration = () => ({
        inspect: (key) => (key === "proxyUrl" ? { globalValue: "https://gateway.test" } : undefined),
    });
    t.after(() => {
        delete vscode.workspace.getConfiguration;
    });
    const { auth } = harness({ type: "secret", value: "selected" }, { selected: JSON.stringify(credentials()) });
    let refreshed = 0,
        updates = 0;
    auth.onAuthUpdated(() => {
        updates++;
    });
    await auth.reauthenticate("fixture-project", () => {
        refreshed++;
    });
    assert.equal(terminal.command, "gcloud auth login --project fixture-project --quiet");
    for (const listener of shellListeners) listener({ terminal, execution: { commandLine: { value: terminal.command } }, exitCode: 0 });
    await flush();
    assert.equal(auth.getActiveMethod().type, "secret");
    assert.equal(refreshed, 1);
    assert.equal(updates, 1);
    assert.equal(shellListeners.size, 0);
    assert.equal(shellStartListeners.size, 0);
    assert.equal(closeListeners.size, 0);
});

test("closing the login terminal releases subscriptions and ignores its late completion", async () => {
    const { auth } = harness({ type: "secret", value: "selected" });
    let refreshed = 0;
    await auth.reauthenticate("", () => {
        refreshed++;
    });
    const completion = [...shellListeners][0];
    for (const listener of closeListeners) listener(terminal);
    assert.equal(shellListeners.size, 0);
    assert.equal(shellStartListeners.size, 0);
    assert.equal(closeListeners.size, 0);
    completion({ terminal, execution: { commandLine: { value: terminal.command } }, exitCode: 0 });
    await flush();
    assert.equal(auth.getActiveMethod().type, "secret");
    assert.equal(refreshed, 0);
});

for (const mode of [
    "adc",
    "proxy",
]) {
    test(`${mode} login ignores command lookalikes and refreshes only once for the submitted command`, async (t) => {
        vscode.workspace.getConfiguration = () => ({ inspect: () => (mode === "proxy" ? { globalValue: "https://gateway.test" } : undefined) });
        t.after(() => {
            delete vscode.workspace.getConfiguration;
        });
        const { auth } = harness({ type: "secret", value: "selected" });
        let refreshed = 0;
        await auth.reauthenticate("fixture-project", () => {
            refreshed++;
        });
        const completion = [...shellListeners][0];
        completion({ terminal: {}, execution: { commandLine: { value: terminal.command } }, exitCode: 0 });
        for (const value of [
            "echo fixture",
            "echo 'gcloud auth login'",
            `echo '${terminal.command}'`,
            terminal.command.replace("fixture-project", "another-project"),
            terminal.command.replace(" --quiet", ""),
            `${terminal.command} --extra-argument`,
            `${terminal.command} && echo done`,
            `${terminal.command}; echo done`,
            `${terminal.command}\necho done`,
        ]) {
            completion({ terminal, execution: { commandLine: { value } }, exitCode: 0 });
        }
        assert.equal(shellListeners.size, 1);
        assert.equal(shellStartListeners.size, 1);
        assert.equal(refreshed, 0);
        assert.equal(auth.getActiveMethod().type, "secret");
        const success = { terminal, execution: { commandLine: { value: `  ${terminal.command}\r\n` } }, exitCode: 0 };
        completion(success);
        completion(success);
        await flush();
        assert.equal(refreshed, 1);
        assert.equal(auth.getActiveMethod().type, mode === "adc" ? "adc" : "secret");
        assert.equal(shellListeners.size, 0);
        assert.equal(shellStartListeners.size, 0);
        assert.equal(closeListeners.size, 0);
    });
}

test("login completion belongs to the recorded execution and still checks its complete command", async () => {
    const { auth } = harness({ type: "secret", value: "selected" });
    let refreshed = 0;
    await auth.reauthenticate("fixture-project", () => {
        refreshed++;
    });
    const execution = { commandLine: { value: terminal.command } };
    for (const listener of shellStartListeners) {
        listener({ terminal: {}, execution });
        listener({ terminal, execution: { commandLine: { value: `echo '${terminal.command}'` } } });
        listener({ terminal, execution });
    }
    const completion = [...shellListeners][0];
    completion({ terminal, execution: { commandLine: { value: terminal.command } }, exitCode: 0 });
    execution.commandLine.value = `${terminal.command} && echo done`;
    completion({ terminal, execution, exitCode: 0 });
    assert.equal(refreshed, 0);
    assert.equal(auth.getActiveMethod().type, "secret");
    execution.commandLine.value = terminal.command;
    completion({ terminal, execution, exitCode: 0 });
    completion({ terminal, execution, exitCode: 0 });
    await flush();
    assert.equal(refreshed, 1);
    assert.equal(auth.getActiveMethod().type, "adc");
    assert.equal(shellListeners.size, 0);
    assert.equal(shellStartListeners.size, 0);
    assert.equal(closeListeners.size, 0);
});

test("login completion can use the full command when start metadata was incomplete", async () => {
    const { auth } = harness({ type: "secret", value: "selected" });
    let refreshed = 0;
    await auth.reauthenticate("fixture-project", () => {
        refreshed++;
    });
    const execution = { commandLine: { value: "gcloud auth" } };
    for (const listener of shellStartListeners) listener({ terminal, execution });
    execution.commandLine.value = terminal.command;
    for (const listener of shellListeners) listener({ terminal, execution, exitCode: 0 });
    await flush();
    assert.equal(refreshed, 1);
    assert.equal(auth.getActiveMethod().type, "adc");
    assert.equal(shellListeners.size, 0);
    assert.equal(shellStartListeners.size, 0);
    assert.equal(closeListeners.size, 0);
});

test("login command construction preserves project argument quoting", async () => {
    for (const [
        projectId,
        argument,
    ] of [
        [
            "fixture-project",
            "fixture-project",
        ],
        [
            "team  project",
            "'team  project'",
        ],
        [
            "team'project",
            String.raw`'team'\''project'`,
        ],
    ]) {
        const { auth } = harness({ type: "adc" });
        await auth.reauthenticate(projectId);
        assert.equal(terminal.command, `gcloud auth application-default login --project ${argument} --quiet`);
        for (const listener of closeListeners) listener(terminal);
    }
    assert.equal(shellListeners.size, 0);
    assert.equal(shellStartListeners.size, 0);
    assert.equal(closeListeners.size, 0);
});

test("terminal setup failures release listeners without changing the auth selection", async (t) => {
    const create = vscode.window.createTerminal;
    t.after(() => {
        vscode.window.createTerminal = create;
    });
    vscode.window.createTerminal = () => {
        const result = create();
        result.sendText = () => {
            throw new Error("Fixture terminal setup failed");
        };
        return result;
    };
    const { auth } = harness({ type: "secret", value: "selected" });
    await assert.rejects(auth.reauthenticate("fixture-project"), /Fixture terminal setup failed/);
    assert.equal(shellListeners.size, 0);
    assert.equal(shellStartListeners.size, 0);
    assert.equal(closeListeners.size, 0);
    assert.equal(auth.getActiveMethod().type, "secret");
});

test("post-login refresh failures are logged without exposing callback error contents", async () => {
    const { auth } = harness({ type: "secret", value: "selected" });
    await auth.reauthenticate("", () => {
        throw new Error("fixture-sensitive-fragment");
    });
    for (const listener of shellListeners) listener({ terminal, execution: { commandLine: { value: terminal.command } }, exitCode: 0 });
    await flush();
    assert.equal(auth.getActiveMethod().type, "adc");
    assert.ok(logs.some((message) => message.includes("Post-authentication")));
    assert.ok(logs.every((message) => !message.includes("fixture-sensitive-fragment")));
    assert.equal(shellListeners.size, 0);
    assert.equal(shellStartListeners.size, 0);
    assert.equal(closeListeners.size, 0);
});
