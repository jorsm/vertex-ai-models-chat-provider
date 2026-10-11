const assert = require("node:assert/strict");
const test = require("node:test");
const Module = require("node:module");
const { EffortCatalog } = require("../out/effort/Effort.js");
const models = require("../src/models.json").candidateModels;
let user = {},
    workspace = {},
    fail = false,
    beforeWrite,
    beforeShow;
const pickers = [],
    errors = [],
    writes = [],
    states = [];
class Emitter {
    listeners = new Set();
    event = (fn) => {
        this.listeners.add(fn);
        return { dispose: () => this.listeners.delete(fn) };
    };
    async fire(value) {
        await Promise.all([...this.listeners].map((fn) => fn(value)));
    }
}
class Picker {
    hideEvent = new Emitter();
    acceptEvent = new Emitter();
    buttonEvent = new Emitter();
    items = [];
    activeItems = [];
    selectedItems = [];
    buttons = [];
    onDidHide = this.hideEvent.event;
    onDidAccept = this.acceptEvent.event;
    onDidTriggerButton = this.buttonEvent.event;
    show() {
        beforeShow?.();
        this.visible = true;
    }
    hide() {
        if (this.visible) {
            this.visible = false;
            void this.hideEvent.fire();
        }
    }
    dispose() {
        this.hide();
        this.disposed = true;
    }
    async accept(item) {
        this.selectedItems = [item];
        await this.acceptEvent.fire();
    }
    async button(item) {
        await this.buttonEvent.fire(item);
    }
}
const back = {};
const vscode = {
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    ThemeIcon: class {
        constructor(id) {
            this.id = id;
        }
    },
    QuickInputButtons: { Back: back },
    ProgressLocation: { Notification: 1 },
    CancellationError: class extends Error {},
    CancellationTokenSource: class {
        constructor() {
            const emitter = new Emitter();
            this.token = { isCancellationRequested: false, onCancellationRequested: emitter.event };
            this.emitter = emitter;
        }
        cancel() {
            this.token.isCancellationRequested = true;
            void this.emitter.fire();
        }
        dispose() {
            this.disposed = true;
        }
    },
    workspace: {
        workspaceFolders: [
            {},
            {},
        ],
        getConfiguration: (_section, resource) => {
            assert.equal(resource, undefined);
            return {
                get: () => ({ ...user, ...workspace }),
                inspect: () => ({ globalValue: user, workspaceValue: workspace }),
                update: async (key, value, target) => {
                    await beforeWrite?.();
                    if (fail) throw Error("read-only");
                    writes.push({ key, value, target });
                    if (target === 1) user = value;
                    else workspace = value;
                },
            };
        },
    },
    window: {
        createQuickPick() {
            const picker = new Picker();
            pickers.push(picker);
            return picker;
        },
        showErrorMessage: (v) => errors.push(v),
        showInformationMessage: (v) => errors.push(v),
        withProgress: async (_options, task) => task({}, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }),
    },
};
const load = Module._load;
let ConfigureThinkingEffort, writeEffortPreference;
try {
    Module._load = function (r, ...args) {
        return r === "vscode" ? vscode : load.call(this, r, ...args);
    };
    ({ ConfigureThinkingEffort } = require("../out/effort/ConfigureThinkingEffort.js"));
    ({ writeEffortPreference } = require("../out/effort/EffortConfiguration.js"));
} finally {
    Module._load = load;
}
const flush = () => new Promise(setImmediate);
const deferred = () => {
    let resolve;
    const promise = new Promise((done) => (resolve = done));
    return { promise, resolve };
};
function harness(selected = models.slice(0, 2), last) {
    let state = { models: selected, connectionRevision: 0, catalogRevision: 1 };
    let ensured = 0;
    const provider = {
        getEffortModelSnapshot: () => state,
        ensureInitialDiscovery: async () => {
            ensured++;
        },
    };
    const command = new ConfigureThinkingEffort(provider, { workspaceState: { get: () => last, update: async (key, value) => states.push({ key, value }) } });
    return {
        command,
        get ensured() {
            return ensured;
        },
        change(models = selected) {
            state = { ...state, models, catalogRevision: state.catalogRevision + 1 };
        },
        changeConnection() {
            state = { ...state, connectionRevision: state.connectionRevision + 1 };
        },
    };
}
test.beforeEach(() => {
    user = {};
    workspace = {};
    fail = false;
    beforeWrite = undefined;
    beforeShow = undefined;
    pickers.length = 0;
    errors.length = 0;
    writes.length = 0;
    states.length = 0;
    vscode.workspace.workspaceFolders = [
        {},
        {},
    ];
});
async function open(h) {
    const running = h.command.run();
    await flush();
    return { running, p: pickers.at(-1) };
}

test("explicit model step uses discovered policy, remembers last configured and saves User by selected key", async () => {
    const h = harness(models.slice(0, 2), "claude-opus-5");
    user = { "claude-opus-5-5": "high" };
    workspace = { other: "low" };
    const { running, p } = await open(h);
    assert.equal(p.items.length, 2);
    assert.equal(p.activeItems[0].modelId, "claude-opus-5");
    assert(p.items.every((item) => item.detail === undefined));
    assert.equal(p.items.find((item) => item.modelId === "claude-opus-5-5").description, "High");
    assert(!p.items.some((item) => /Active Chat/.test(item.detail)));
    await p.accept(p.items.find((item) => item.modelId === "claude-opus-5-5"));
    assert.match(p.title, /User/);
    assert.equal(p.activeItems[0].value, "high");
    assert.deepEqual(
        p.items.filter((i) => i.value).map((i) => i.value),
        [
            "low",
            "medium",
            "high",
            "xhigh",
            "max",
        ],
    );
    await p.accept(p.items.find((i) => i.value === "max"));
    await running;
    assert.deepEqual(user, { "claude-opus-5-5": "max" });
    assert.deepEqual(workspace, { other: "low" });
    assert.equal(states[0].value, "claude-opus-5-5");
    assert(p.disposed);
    assert.equal(h.ensured, 1);
    assert.equal(p.acceptEvent.listeners.size, 0);
    assert.equal(p.buttonEvent.listeners.size, 0);
});
test("existing Workspace key sets scope; default choice saves its actual named level", async () => {
    user = { "claude-opus-5-5": "max" };
    workspace = { "claude-opus-5-5": "high", other: "low" };
    const h = harness(models.slice(0, 1));
    const { running, p } = await open(h);
    assert.match(p.title, /Workspace/);
    assert.deepEqual(
        p.items.map((i) => [
            i.label,
            i.description,
        ]),
        [
            [
                "Low",
                undefined,
            ],
            [
                "Medium",
                "Default",
            ],
            [
                "High",
                undefined,
            ],
            [
                "Extra high",
                undefined,
            ],
            [
                "Max",
                undefined,
            ],
        ],
    );
    await p.accept(p.items.find((i) => i.value === "medium"));
    await running;
    assert.equal(workspace["claude-opus-5-5"], "medium");
    assert.equal(workspace.other, "low");
    assert.equal(user["claude-opus-5-5"], "max");
});
test("switch scope changes only chosen target; no workspace offers only Back", async () => {
    const h = harness(models.slice(0, 1));
    let { running, p } = await open(h);
    await p.button(p.buttons.find((b) => b !== back));
    assert.match(p.title, /Workspace/);
    await p.accept(p.items.find((i) => i.value === "high"));
    await running;
    assert.deepEqual(user, {});
    assert.equal(workspace["claude-opus-5-5"], "high");
    vscode.workspace.workspaceFolders = [];
    workspace = {};
    ({ running, p } = await open(h));
    assert.deepEqual(p.buttons, [back]);
    p.hide();
    await running;
});
test("cancel each step and Back never writes; repeated invocation disposes old picker", async () => {
    const h = harness();
    let { running, p } = await open(h);
    p.hide();
    await running;
    ({ running, p } = await open(h));
    await p.accept(p.items[0]);
    await p.button(back);
    assert.match(p.title, /Choose model/);
    p.hide();
    await running;
    ({ running, p } = await open(h));
    const old = p;
    const second = h.command.run();
    await flush();
    await running;
    assert(old.disposed);
    pickers.at(-1).hide();
    await second;
    assert.equal(writes.length, 0);
    assert.equal(states.length, 0);
});
test("stale policy refresh prevents persistence and removes no longer permitted choices", async () => {
    const h = harness(models.slice(0, 1));
    const { running, p } = await open(h);
    const changed = structuredClone(models[0]);
    changed.effort = { values: ["high"], default: "high" };
    h.change([changed]);
    await p.accept(p.items.find((i) => i.value === "max"));
    assert.equal(writes.length, 0);
    assert.match(errors[0], /changed/);
    assert(!p.items.some((i) => i.value === "max"));
    assert(p.visible);
    await p.accept(p.items.find((i) => i.value === "high"));
    await running;
    assert.equal(user["claude-opus-5-5"], "high");
});
test("setting failure keeps picker open and effective state unchanged", async () => {
    const h = harness(models.slice(0, 1));
    user = { "claude-opus-5-5": "high" };
    const { running, p } = await open(h);
    fail = true;
    await p.accept(p.items.find((i) => i.value === "max"));
    assert(p.visible);
    assert.match(errors[0], /read-only/);
    assert.equal(user["claude-opus-5-5"], "high");
    assert.equal(states.length, 0);
    assert.equal(p.activeItems[0].value, "high");
    p.hide();
    await running;
});
test("invalid saved value stays visible and can be reset rather than silently substituted", async () => {
    const h = harness(models.slice(0, 1));
    user = { "claude-opus-5-5": "minimal" };
    const { running, p } = await open(h);
    assert.match(p.placeholder, /Invalid.*not permitted/);
    assert.equal(p.activeItems.length, 0);
    await p.accept(p.items.find((i) => i.value === "medium"));
    await running;
    assert.equal(user["claude-opus-5-5"], "medium");
});
test("empty catalogs and models without effort offer no fabricated choices", async () => {
    for (const selection of [
        [],
        models.filter((m) => !m.effort),
    ]) {
        const h = harness(selection);
        await h.command.run();
        assert.equal(pickers.length, 0);
    }
    assert.equal(errors.length, 2);
    assert.equal(writes.length, 0);
});
test("removal of configured model while picker is open returns to remaining models without writing", async () => {
    const h = harness();
    const { running, p } = await open(h);
    await p.accept(p.items[0]);
    h.change([models[1]]);
    await p.accept(p.items.find((i) => i.value === "max"));
    assert.equal(writes.length, 0);
    assert.match(p.title, /Choose model/);
    assert.equal(p.items[0].modelId, models[1].id);
    p.hide();
    await running;
});

test("null preference remains invalid with no falsely marked effective default", async () => {
    const h = harness(models.slice(0, 1));
    user = { "claude-opus-5-5": null };
    const { running, p } = await open(h);
    assert.match(p.placeholder, /Invalid/);
    assert.equal(p.activeItems.length, 0);
    assert(!p.items.some((i) => i.description === "Current effective choice"));
    p.hide();
    await running;
});

test("named default is one choice, highlights an existing value and saves the default at the chosen scope", async () => {
    const model = models.find((m) => m.id === "claude-haiku-5-5");
    user = { [model.id]: "max" };
    workspace = { [model.id]: "medium" };
    const h = harness([model]);
    const { running, p } = await open(h);
    assert.deepEqual(
        p.items
            .filter((i) => i.value)
            .map((i) => [
                i.label,
                i.value,
            ]),
        [
            [
                "Low",
                "low",
            ],
            [
                "Medium",
                "medium",
            ],
            [
                "High",
                "high",
            ],
            [
                "Extra high",
                "xhigh",
            ],
            [
                "Max",
                "max",
            ],
        ],
    );
    assert.equal(p.activeItems[0].label, "Medium");
    assert.equal(p.activeItems[0].description, "Default");
    await p.accept(p.activeItems[0]);
    await running;
    assert.equal(workspace[model.id], "medium");
    assert.equal(user[model.id], "max");
});
test("malformed Workspace object in model step is reported without an unhandled event rejection", async () => {
    const h = harness();
    workspace = [];
    const { running, p } = await open(h);
    await p.accept(p.items[0]);
    assert.match(errors[0], /must be an object/);
    assert.equal(writes.length, 0);
    assert.match(p.title, /Choose model/);
    p.hide();
    await running;
});

test("picker setup failure releases subscriptions before a hide event can occur", async () => {
    const h = harness();
    beforeShow = () => {
        throw Error("picker could not open");
    };
    await h.command.run();
    const p = pickers.at(-1);
    assert(p.disposed);
    assert.equal(p.hideEvent.listeners.size, 0);
    assert.equal(p.acceptEvent.listeners.size, 0);
    assert.equal(p.buttonEvent.listeners.size, 0);
    assert.match(errors[0], /picker could not open/);
    assert.equal(writes.length, 0);
});

test("closing a picker cancels its queued write and leaves other writes intact", async () => {
    const started = deferred();
    const release = deferred();
    beforeWrite = async () => {
        beforeWrite = undefined;
        started.resolve();
        await release.promise;
    };
    const blockingWrite = writeEffortPreference("other", "high", vscode.ConfigurationTarget.Global);
    await started.promise;
    const h = harness(models.slice(0, 1));
    const { running, p } = await open(h);
    const accepting = p.accept(p.items.find((item) => item.value === "max"));
    h.command.dispose();
    await running;
    release.resolve();
    await Promise.all([
        blockingWrite,
        accepting,
    ]);
    assert.deepEqual(user, { other: "high" });
    assert.equal(writes.length, 1);
    assert.equal(states.length, 0);
    assert.equal(errors.length, 0);
    assert(p.disposed);
    assert.equal(p.acceptEvent.listeners.size, 0);
});

test("connection changes while a write is queued require reselection before saving", async () => {
    const started = deferred();
    const release = deferred();
    beforeWrite = async () => {
        beforeWrite = undefined;
        started.resolve();
        await release.promise;
    };
    const blockingWrite = writeEffortPreference("other", "high", vscode.ConfigurationTarget.Global);
    await started.promise;
    const h = harness(models.slice(0, 1));
    const { running, p } = await open(h);
    const accepting = p.accept(p.items.find((item) => item.value === "max"));
    h.changeConnection();
    release.resolve();
    await Promise.all([
        blockingWrite,
        accepting,
    ]);
    assert.deepEqual(user, { other: "high" });
    assert.equal(states.length, 0);
    assert.match(errors[0], /changed/);
    assert(p.visible);
    assert.equal(p.busy, false);
    await p.accept(p.items.find((item) => item.value === "high"));
    await running;
    assert.equal(user[models[0].id], "high");
});

test("pending persistence ignores duplicate accepts and scope changes", async () => {
    const started = deferred();
    const release = deferred();
    beforeWrite = async () => {
        started.resolve();
        await release.promise;
    };
    const h = harness(models.slice(0, 1));
    const { running, p } = await open(h);
    const accepting = p.accept(p.items.find((item) => item.value === "max"));
    await started.promise;
    await p.accept(p.items.find((item) => item.value === "high"));
    await p.button(p.buttons.find((button) => button !== back));
    assert.match(p.title, /User/);
    release.resolve();
    await accepting;
    await running;
    assert.equal(writes.length, 1);
    assert.equal(user[models[0].id], "max");
    assert.deepEqual(workspace, {});
});

test("closing during an active settings write does not update last-model state afterward", async () => {
    const started = deferred();
    const release = deferred();
    beforeWrite = async () => {
        started.resolve();
        await release.promise;
    };
    const h = harness(models.slice(0, 1));
    const { running, p } = await open(h);
    const accepting = p.accept(p.items.find((item) => item.value === "max"));
    await started.promise;
    p.hide();
    await running;
    release.resolve();
    await accepting;
    assert.equal(user[models[0].id], "max");
    assert.equal(states.length, 0);
    assert.equal(errors.length, 0);
    assert(p.disposed);
});
