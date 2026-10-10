const assert = require("node:assert/strict");
const Module = require("node:module");
const test = require("node:test");
const manifest = require("../package.json");
const modelSetting = manifest.contributes.configuration.properties["vertexAiChat.commitMessageModel"];

class TextPart {
    constructor(value) {
        this.value = value;
    }
}
const rootA = { fsPath: "/a" },
    rootB = { fsPath: "/b" };
let userSettings, workspaceSettings, folderSettings, configurations, errors, repo, diffReads;
let pickerCalls, pickerSelection, updates, warnings;
const vscode = {
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    LanguageModelTextPart: TextPart,
    LanguageModelChatMessage: class {
        constructor(role, content) {
            this.role = role;
            this.content = [new TextPart(content)];
        }
        static User(content) {
            return new this(1, content);
        }
    },
    LanguageModelChatToolMode: { Auto: 1 },
    CancellationError: class extends Error {},
    CancellationTokenSource: class {
        token = { isCancellationRequested: false };
        cancel() {
            this.token.isCancellationRequested = true;
        }
        dispose() {}
    },
    ProgressLocation: { Notification: 1 },
    window: {
        activeTextEditor: { document: { uri: rootA } },
        createOutputChannel: () => ({ appendLine() {} }),
        showErrorMessage: (message) => errors.push(message),
        showInformationMessage() {},
        showWarningMessage: (message) => warnings.push(message),
        showQuickPick: async (items, options) => {
            pickerCalls.push({ items, options });
            return items.find((item) => item.modelId === pickerSelection);
        },
        withProgress: async (_options, callback) =>
            callback(
                {},
                {
                    isCancellationRequested: false,
                    onCancellationRequested: () => ({ dispose() {} }),
                },
            ),
    },
    workspace: {
        getConfiguration: (section, resource) => {
            configurations.push([
                section,
                resource,
            ]);
            return {
                get: (key) => {
                    for (const scope of [
                        folderSettings.get(resource),
                        workspaceSettings,
                        userSettings,
                    ]) {
                        if (scope?.[key] !== undefined) return scope[key];
                    }
                    return manifest.contributes.configuration.properties[`${section}.${key}`]?.default;
                },
                inspect: (key) => ({
                    globalValue: userSettings[key],
                    workspaceValue: workspaceSettings[key],
                    workspaceFolderValue: folderSettings.get(resource)?.[key],
                }),
                update: async (key, value, target) => {
                    updates.push({ key, value, target, resource });
                    if (target === vscode.ConfigurationTarget.Global) userSettings[key] = value;
                    else if (target === vscode.ConfigurationTarget.Workspace) workspaceSettings[key] = value;
                    else folderSettings.set(resource, { ...folderSettings.get(resource), [key]: value });
                },
            };
        },
        getWorkspaceFolder: (resource) => vscode.workspace.workspaceFolders?.find((folder) => folder.uri === resource),
    },
    extensions: {
        getExtension: () => ({ isActive: true, exports: { getAPI: () => ({ getRepository: () => repo }) } }),
    },
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    return request === "vscode" ? vscode : originalLoad.call(this, request, parent, isMain);
};

let DEFAULT_SYSTEM_PROMPT;
let resolveCommitMessageResourceUri;
let generateCommitMessage;
let selectCommitMessageModel;
try {
    ({ DEFAULT_SYSTEM_PROMPT, resolveCommitMessageResourceUri, generateCommitMessage } = require("../out/commitMessage/CommitMessage.js"));
    ({ selectCommitMessageModel } = require("../out/commitMessage/CommitMessageModelSelection.js"));
} finally {
    Module._load = originalLoad;
}

test.beforeEach(() => {
    userSettings = {};
    workspaceSettings = {};
    folderSettings = new Map();
    configurations = [];
    errors = [];
    warnings = [];
    updates = [];
    pickerCalls = [];
    pickerSelection = undefined;
    vscode.window.activeTextEditor = { document: { uri: rootA } };
    vscode.workspace.workspaceFolders = [
        { uri: rootA },
        { uri: rootB },
    ];
    vscode.workspace.workspaceFile = undefined;
    diffReads = 0;
    repo = {
        rootUri: rootB,
        inputBox: { value: "" },
        state: { indexChanges: [{ uri: { fsPath: "/b/file.ts" } }] },
        diffIndexWithHEAD: async () => {
            diffReads++;
            return "+new code";
        },
    };
});

function inferenceHarness(error) {
    const calls = [];
    return {
        calls,
        async infer(...args) {
            calls.push(args);
            if (error) throw error;
            args[3].report(new TextPart("feat: change"));
        },
    };
}

test("exports default conventional commit system prompt", () => {
    assert.ok(DEFAULT_SYSTEM_PROMPT);
    assert.match(DEFAULT_SYSTEM_PROMPT, /Conventional Commits/);
    assert.match(DEFAULT_SYSTEM_PROMPT, /<type>\(<scope>\): <subject>/);
});

test("resolves the repository URI from an SCM title command context", () => {
    const rootUri = { scheme: "file", fsPath: "/workspace/repository" };

    assert.equal(resolveCommitMessageResourceUri({ rootUri }), rootUri);
    assert.equal(resolveCommitMessageResourceUri(rootUri), rootUri);
    assert.equal(resolveCommitMessageResourceUri(undefined), undefined);
});

for (const scope of [
    "user",
    "workspace",
    "folder",
]) {
    test(`commit generation uses the effective ${scope} model with repository settings`, async () => {
        userSettings.commitMessageModel = "user-model";
        if (scope !== "user") workspaceSettings.commitMessageModel = "workspace-model";
        if (scope === "folder") folderSettings.set(rootB, { commitMessageModel: "folder-model" });
        const h = inferenceHarness();
        await generateCommitMessage(h, { rootUri: rootB });
        assert.equal(h.calls.length, 1);
        assert.equal(h.calls[0][0], `${scope}-model`);
        assert.equal(h.calls[0][5], rootB);
        assert.deepEqual(configurations, [
            [
                "vertexAiChat",
                rootB,
            ],
        ]);
        assert.equal(h.calls[0][1][0].content[0].value, DEFAULT_SYSTEM_PROMPT);
        assert.match(h.calls[0][1][1].content[0].value, /Git Diff:\n\+new code/);
        assert.equal(repo.inputBox.value, "feat: change");
        assert.deepEqual(errors, []);
    });
}

test("commit generation honors a custom model ID and a custom prompt independently of VS Code utility settings", async () => {
    userSettings.commitMessageModel = "commit-company-model";
    userSettings["chat.utilitySmallModel"] = "another-provider-model";
    folderSettings.set(rootB, { commitMessagePrompt: "  My custom system prompt.  " });
    const h = inferenceHarness();
    await generateCommitMessage(h, rootB);
    assert.equal(h.calls[0][0], "commit-company-model");
    assert.equal(h.calls[0][1][0].content[0].value, "My custom system prompt.");
    assert.deepEqual(configurations, [
        [
            "vertexAiChat",
            rootB,
        ],
    ]);
});

test("commit generation defaults to the catalog's Gemini 3 Flash ID", async () => {
    assert.equal(modelSetting.default, "gemini-3-flash-preview");
    assert.equal(modelSetting.type, "string");
    assert.equal(modelSetting.scope, "resource");
    assert.ok(require("../src/models.json").candidateModels.some((model) => model.id === modelSetting.default));
    const h = inferenceHarness();
    await generateCommitMessage(h, rootB);
    assert.equal(h.calls[0][0], modelSetting.default);
    assert.deepEqual(updates, []);
});

for (const value of [
    "",
    "  ",
]) {
    test(`an explicitly blank commit model (${JSON.stringify(value)}) reports configuration error without inference`, async () => {
        userSettings.commitMessageModel = value;
        const h = inferenceHarness();
        await generateCommitMessage(h, rootB);
        assert.equal(h.calls.length, 0);
        assert.equal(diffReads, 0);
        assert.equal(errors.length, 1);
        assert.match(errors[0], /Set 'vertexAiChat.commitMessageModel'/);
    });
}

test("a blank folder override does not silently use the user model", async () => {
    userSettings.commitMessageModel = "user-model";
    folderSettings.set(rootB, { commitMessageModel: "" });
    const h = inferenceHarness();
    await generateCommitMessage(h, rootB);
    assert.equal(h.calls.length, 0);
    assert.equal(errors.length, 1);
});

test("an unavailable saved model reports the shared inference error without retrying another model or changing settings", async () => {
    userSettings.commitMessageModel = "previously-available-model";
    const h = inferenceHarness(new Error("Model not available: previously-available-model"));
    await generateCommitMessage(h, rootB);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0][0], "previously-available-model");
    assert.equal(errors.length, 1);
    assert.match(errors[0], /Model not available: previously-available-model/);
    assert.equal(userSettings.commitMessageModel, "previously-available-model");
});

function discoveryHarness(
    models = [
        { id: "grok-test", displayName: "Grok", vendor: "x-ai", family: "grok" },
        { id: modelSetting.default, displayName: "Gemini 3 Flash", vendor: "google", family: "gemini" },
    ],
) {
    return {
        calls: 0,
        async discoverModelsAndRegion() {
            this.calls++;
            return { region: "europe-west8", availableModels: models };
        },
    };
}

test("the model picker shows the complete current catalog and puts the configured default first", async () => {
    const h = discoveryHarness();
    pickerSelection = "grok-test";
    await selectCommitMessageModel(h, { rootUri: rootB });
    assert.equal(h.calls, 1);
    assert.equal(pickerCalls.length, 1);
    assert.deepEqual(
        pickerCalls[0].items.map((item) => item.modelId),
        [
            modelSetting.default,
            "grok-test",
        ],
    );
    assert.match(pickerCalls[0].items[0].description, /Current/);
    assert.deepEqual(updates, [{ key: "commitMessageModel", value: "grok-test", target: 3, resource: rootB }]);
    assert.deepEqual(configurations, [
        [
            "vertexAiChat",
            rootB,
        ],
    ]);
});

for (const scope of [
    "user",
    "workspace",
    "folder",
]) {
    test(`the model picker preserves an existing ${scope} setting's scope`, async () => {
        userSettings.commitMessageModel = "user-model";
        if (scope !== "user") workspaceSettings.commitMessageModel = "workspace-model";
        if (scope === "folder") folderSettings.set(rootB, { commitMessageModel: "folder-model" });
        const current = `${scope}-model`;
        pickerSelection = "replacement-model";
        await selectCommitMessageModel(
            discoveryHarness([
                { id: pickerSelection, displayName: "Replacement", vendor: "future-vendor", family: "future" },
                { id: current, displayName: "Current", vendor: "google", family: "gemini" },
            ]),
            rootB,
        );
        assert.equal(pickerCalls[0].items[0].modelId, current);
        assert.equal(updates[0].target, { user: 1, workspace: 2, folder: 3 }[scope]);
        assert.equal(updates[0].value, pickerSelection);
    });
}

test("a new selection without an open workspace is saved in user settings", async () => {
    vscode.workspace.workspaceFolders = undefined;
    vscode.window.activeTextEditor = undefined;
    pickerSelection = "grok-test";
    await selectCommitMessageModel(discoveryHarness());
    assert.deepEqual(updates, [{ key: "commitMessageModel", value: "grok-test", target: 1, resource: undefined }]);
});

test("cancelling the picker leaves an unavailable saved model unchanged", async () => {
    userSettings.commitMessageModel = "previously-available-model";
    await selectCommitMessageModel(discoveryHarness(), rootB);
    assert.deepEqual(
        pickerCalls[0].items.map((item) => item.modelId),
        [
            "grok-test",
            modelSetting.default,
        ],
    );
    assert.deepEqual(updates, []);
    assert.equal(userSettings.commitMessageModel, "previously-available-model");
});

test("an empty or failed discovery does not open the picker or change settings", async () => {
    await selectCommitMessageModel(discoveryHarness([]), rootB);
    assert.equal(warnings.length, 1);
    await selectCommitMessageModel(
        {
            discoverModelsAndRegion: async () => {
                throw new Error("Proxy discovery failed");
            },
        },
        rootB,
    );
    assert.equal(errors.length, 1);
    assert.match(errors[0], /Proxy discovery failed/);
    assert.deepEqual(pickerCalls, []);
    assert.deepEqual(updates, []);
});

test("an unavailable default reports an inference error without choosing another model", async () => {
    const h = inferenceHarness(new Error(`Model not available: ${modelSetting.default}`));
    await generateCommitMessage(h, rootB);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0][0], modelSetting.default);
    assert.match(errors[0], /Model not available: gemini-3-flash-preview/);
    assert.deepEqual(updates, []);
});

test("commit picker exposes every literal catalog model, including custom backend names", async () => {
    const regular = { id: "company-standard", version: "company-model-v1", displayName: "Company standard", vendor: "anthropic", family: "claude" };
    const custom = { ...regular, id: "company-special", version: "company-model-high", displayName: "Company special" };
    const h = discoveryHarness([
        regular,
        custom,
    ]);
    pickerSelection = regular.id;
    await selectCommitMessageModel(h, { rootUri: rootB });
    assert.equal(pickerCalls[0].items.length, 2);
    assert.equal(updates[0].value, regular.id);
    assert.equal(updates[0].resource, rootB);
});
