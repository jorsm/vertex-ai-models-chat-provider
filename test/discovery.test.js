const assert = require("node:assert/strict");
const Module = require("node:module");
const test = require("node:test");

const logs = [];
const settings = {};
class Logger {
    log(message) {
        logs.push(message);
    }
    error(message) {
        logs.push(message);
    }
}
class CancellationError extends Error {}
const vscode = {
    CancellationError,
    EventEmitter: class {
        event = () => ({ dispose() {} });
        fire() {}
    },
    version: "1.120.0",
    workspace: { getConfiguration: () => ({ get: (key, fallback) => settings[key] ?? fallback, inspect: () => ({}) }) },
    window: { showErrorMessage() {}, showWarningMessage() {} },
};
const originalLoad = Module._load;
let VertexChatModelDispatcher, VertexAnthropicProvider, VertexGoogleProvider, VertexGrokProvider;
try {
    Module._load = function (request, parent, isMain) {
        if (request === "vscode") return vscode;
        if (request.endsWith("/Logger")) return { Logger };
        return originalLoad.call(this, request, parent, isMain);
    };
    ({ VertexChatModelDispatcher } = require("../out/VertexChatModelDispatcher.js"));
    ({ VertexAnthropicProvider } = require("../out/providers/VertexAnthropicProvider.js"));
    ({ VertexGoogleProvider } = require("../out/providers/VertexGoogleProvider.js"));
    ({ VertexGrokProvider } = require("../out/providers/VertexGrokProvider.js"));
} finally {
    Module._load = originalLoad;
}
const { DISCOVERY_PROBE_TIMEOUT_MS, probeWithDeadline, probeWithRetries, resolveDiscoveryTimeoutMs, runDiscoveryQueue, DiscoveryRetryableError } = require("../out/utils/discovery.js");
const { VertexAuthenticationError } = require("../out/utils/retry.js");
const catalogModel = require("../src/models.json").candidateModels[0];
const model = (id, vendor = "anthropic") => ({ ...catalogModel, id, version: id, vendor });
const flush = () => new Promise((resolve) => setImmediate(resolve));
const never = () => new Promise(() => {});
const emptyUsage = { usage: { input: 0, output: 0 }, charCount: {} };

test.afterEach(() => {
    delete settings.modelDiscoveryTimeoutSeconds;
});

function cancellation() {
    const listeners = new Set();
    const token = {
        isCancellationRequested: false,
        onCancellationRequested(fn) {
            listeners.add(fn);
            return { dispose: () => listeners.delete(fn) };
        },
    };
    return {
        token,
        listeners,
        cancel() {
            token.isCancellationRequested = true;
            for (const fn of listeners) fn();
        },
    };
}

function harness(models, regions = ["global"]) {
    // Skip SDK initialization: discovery uses fake providers and never calls the network.
    class Dispatcher extends VertexChatModelDispatcher {
        registerProviders() {}
    }
    const catalog = { getEffectiveCatalog: async () => ({ candidateModels: models, regionPriority: regions }) };
    const auth = { onAuthUpdated() {}, getResolvedAuthOptions: async () => undefined };
    const dispatcher = new Dispatcher("test-project", {}, auth, catalog);
    dispatcher.discoveryStartDelayMs = () => 0;
    return {
        dispatcher,
        add(vendor, pingModel, inference = async () => emptyUsage) {
            const provider = {
                vendor,
                initialize(_project, region) {
                    this.region = region;
                },
                setLabels() {},
                pingModel,
                provideLanguageModelChatResponse: inference,
            };
            dispatcher.activeProviders.set(vendor, provider);
            return provider;
        },
    };
}

test("bundled models use 15 literal endpoint probes and keep catalog order across refreshes", async () => {
    const models = require("../src/models.json").candidateModels;
    const h = harness(models);
    const requests = [];
    for (const vendor of ["anthropic", "google", "grok"]) {
        h.add(vendor, async (id) => {
            requests.push([vendor, id]);
            return true;
        });
    }
    for (let refresh = 0; refresh < 2; refresh++) {
        const before = requests.length;
        const result = await h.dispatcher.discoverModelsAndRegion();
        assert.deepEqual(result.availableModels, models);
        const probes = requests.slice(before);
        assert.equal(probes.length, 15);
        assert.equal(new Set(probes.map((target) => JSON.stringify(target))).size, 15);
        assert.equal(probes.filter(([vendor]) => vendor === "anthropic").length, 10);
        assert.equal(probes.filter(([vendor]) => vendor === "google").length, 4);
        assert.deepEqual(
            probes.filter(([vendor]) => vendor === "grok"),
            [["grok", "xai/grok-4.6"]],
        );
        assert(probes.some(([vendor, id]) => vendor === "anthropic" && id === "claude-sonnet-5-5"));
        assert.deepEqual(
            probes.filter(([vendor, id]) => vendor === "anthropic" && id === "claude-haiku-5-5"),
            [["anthropic", "claude-haiku-5-5"]],
        );
    }
});

test("custom catalogs use version rather than UI ID and keep vendor/version boundaries", async () => {
    const models = [
        { ...model("Display-Max"), version: "company-reasoner-high" },
        { ...model("Display-Low"), version: "company-reasoner-low" },
        { ...model("Display-Other-Version"), version: "company-reasoner-other-high" },
        { ...model("Display-Other-Vendor", "google"), version: "company-reasoner" },
        { ...model("Display-Unknown-Suffix"), version: "company-reasoner-ultra" },
    ];
    const h = harness(models);
    const requests = [];
    for (const vendor of ["anthropic", "google"]) {
        h.add(vendor, async (id) => {
            requests.push([vendor, id]);
            return id !== "company-reasoner-other-high";
        });
    }
    const result = await h.dispatcher.discoverModelsAndRegion();
    assert.deepEqual(requests, [
        ["anthropic", "company-reasoner-high"],
        ["anthropic", "company-reasoner-low"],
        ["anthropic", "company-reasoner-other-high"],
        ["google", "company-reasoner"],
        ["anthropic", "company-reasoner-ultra"],
    ]);
    assert.deepEqual(
        result.availableModels.map((m) => m.id),
        ["Display-Max", "Display-Low", "Display-Other-Vendor", "Display-Unknown-Suffix"],
    );
});

test("one timed-out backend excludes every entry sharing that version even if it succeeds late", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const entries = ["first", "second", "third"].map((id) => ({ ...model(id), version: "company-reasoner-v1" }));
    const healthy = model("healthy", "google");
    const h = harness([...entries, healthy]);
    let calls = 0,
        finishLate,
        signal;
    h.add("anthropic", (_id, options) => {
        calls++;
        signal = options.signal;
        return new Promise((resolve) => {
            finishLate = resolve;
        });
    });
    h.add("google", async () => true);
    const discovery = h.dispatcher.discoverModelsAndRegion();
    await flush();
    assert.equal(calls, 1);
    t.mock.timers.tick(DISCOVERY_PROBE_TIMEOUT_MS);
    assert.deepEqual((await discovery).availableModels, [healthy]);
    assert.equal(signal.aborted, true);
    finishLate(true);
    await flush();
    assert.deepEqual(h.dispatcher.availableModels, [healthy]);
});

test("grouped endpoints are re-probed in each region after shared failure", async () => {
    const entries = ["first", "second", "third"].map((id) => ({ ...model(id), version: "company-reasoner-v1" }));
    const h = harness(entries, ["asia-northeast1", "europe-west8"]);
    const requests = [];
    h.add("anthropic", async function (id) {
        requests.push([this.region, id]);
        return this.region === "europe-west8";
    });
    const result = await h.dispatcher.discoverModelsAndRegion();
    assert.equal(result.region, "europe-west8");
    assert.deepEqual(result.availableModels, entries);
    assert.deepEqual(requests, [
        ["asia-northeast1", "company-reasoner-v1"],
        ["europe-west8", "company-reasoner-v1"],
    ]);
});

test("a stuck probe times out, aborts, and unblocks healthy-model inference", async (t) => {
    assert.equal(DISCOVERY_PROBE_TIMEOUT_MS, 45_000);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = harness([model("healthy"), model("slow", "grok")]);
    let called = false,
        slowSignal;
    h.add(
        "anthropic",
        async () => true,
        async () => {
            called = true;
            return emptyUsage;
        },
    );
    h.add("grok", async (_id, { signal }) => {
        slowSignal = signal;
        return never();
    });
    const discovery = h.dispatcher.discoverModelsAndRegion();
    await flush();
    const chat = cancellation();
    const inference = h.dispatcher.provideLanguageModelChatResponse({ id: "healthy" }, [], {}, { report() {} }, chat.token);
    await flush();
    assert.equal(called, false);
    assert.deepEqual(h.dispatcher.availableModels, []);
    t.mock.timers.tick(DISCOVERY_PROBE_TIMEOUT_MS - 1);
    await flush();
    assert.equal(slowSignal.aborted, false);
    t.mock.timers.tick(1);
    const result = await discovery;
    await inference;
    assert.deepEqual(
        result.availableModels.map((m) => m.id),
        ["healthy"],
    );
    assert.equal(called, true);
    assert.equal(slowSignal.aborted, true);
    assert.equal(h.dispatcher._discoveryPromise, null);
    assert.equal(chat.listeners.size, 0);
    assert(logs.some((line) => line.includes("Ping timed out for slow in global")));
});

test("custom discovery timeout reaches providers and is re-read on refresh", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = harness([model("slow")]);
    const requests = [];
    h.add("anthropic", (_id, options) => {
        requests.push(options);
        return never();
    });
    for (const seconds of [90, 5]) {
        settings.modelDiscoveryTimeoutSeconds = seconds;
        const discovery = h.dispatcher.discoverModelsAndRegion();
        await flush();
        const request = requests.at(-1);
        assert.equal(request.timeoutMs, seconds * 1000);
        t.mock.timers.tick(seconds * 1000 - 1);
        await flush();
        assert.equal(request.signal.aborted, false);
        t.mock.timers.tick(1);
        assert.deepEqual((await discovery).availableModels, []);
        assert.equal(request.signal.aborted, true);
        assert(logs.some((line) => line.includes(`Ping timed out for slow in global after ${seconds * 1000}ms`)));
    }
});

test("invalid discovery timeout settings fall back to the 45-second default", () => {
    for (const value of [undefined, null, "90", 0, -1, 1.5, NaN, Infinity, 2_147_484]) {
        assert.equal(resolveDiscoveryTimeoutMs(value), 45_000);
    }
    assert.equal(resolveDiscoveryTimeoutMs(1), 1000);
    assert.equal(resolveDiscoveryTimeoutMs(2_147_483), 2_147_483_000);
    const setting = require("../package.json").contributes.configuration.properties["vertexAiChat.modelDiscoveryTimeoutSeconds"];
    assert.equal(setting.default, 45);
    assert.equal(setting.minimum, 1);
    assert.equal(setting.maximum, 2_147_483);
});

test("timed-out regions advance and late probe success cannot change the chosen region", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = harness([model("healthy")], ["global", "europe-west1"]);
    let finishLate, oldSignal;
    h.add("anthropic", function (_id, { signal }) {
        if (this.region === "global") {
            oldSignal = signal;
            return new Promise((resolve) => {
                finishLate = resolve;
            });
        }
        return Promise.resolve(true);
    });
    const discovery = h.dispatcher.discoverModelsAndRegion();
    await flush();
    t.mock.timers.tick(DISCOVERY_PROBE_TIMEOUT_MS);
    const result = await discovery;
    assert.equal(result.region, "europe-west1");
    assert.equal(oldSignal.aborted, true);
    finishLate(true);
    await flush();
    assert.equal(h.dispatcher.region, "europe-west1");
    assert.deepEqual(h.dispatcher.availableModels, result.availableModels);
});

test("completed empty discovery and cleared models do not fall back to the catalog", async () => {
    const h = harness([model("unavailable")]);
    h.add("anthropic", async () => false);
    assert.deepEqual(await h.dispatcher.provideLanguageModelChatInformation(), []);
    assert.deepEqual((await h.dispatcher.discoverModelsAndRegion()).availableModels, []);
    assert.deepEqual(await h.dispatcher.provideLanguageModelChatInformation(), []);
    await assert.rejects(h.dispatcher.provideLanguageModelChatResponse({ id: "unavailable" }, [], {}, {}, cancellation().token), /Model not available/);
    h.dispatcher.setProjectId("new-project");
    h.dispatcher.clearModels();
    assert.deepEqual(await h.dispatcher.provideLanguageModelChatInformation(), []);
});

test("cancelling one chat stops its wait without cancelling shared discovery", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = harness([model("slow")]);
    let finishProbe, signal;
    h.add("anthropic", (_id, options) => {
        signal = options.signal;
        return new Promise((resolve) => {
            finishProbe = resolve;
        });
    });
    const discovery = h.dispatcher.discoverModelsAndRegion();
    await flush();
    const chat = cancellation();
    const rejected = assert.rejects(h.dispatcher.provideLanguageModelChatResponse({ id: "slow" }, [], {}, {}, chat.token), CancellationError);
    chat.cancel();
    await rejected;
    assert.equal(chat.listeners.size, 0);
    assert.equal(signal.aborted, false);
    assert(h.dispatcher._discoveryPromise);
    finishProbe(true);
    assert.equal((await discovery).availableModels.length, 1);
});

test("authentication failure cancels sibling probes and releases discovery", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = harness([model("bad-auth"), model("slow", "grok")]);
    let signal;
    h.add("anthropic", async () => {
        throw new VertexAuthenticationError("expired");
    });
    h.add("grok", (_id, options) => {
        signal = options.signal;
        return never();
    });
    await assert.rejects(h.dispatcher.discoverModelsAndRegion(), VertexAuthenticationError);
    assert.equal(signal.aborted, true);
    assert.equal(h.dispatcher._discoveryPromise, null);
});

test("probe timers are cleared after success and late rejection is handled", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const controller = new AbortController();
    let timeouts = 0,
        rejectLate;
    assert.equal(
        await probeWithDeadline(
            async () => true,
            controller.signal,
            () => timeouts++,
        ),
        true,
    );
    t.mock.timers.tick(DISCOVERY_PROBE_TIMEOUT_MS);
    assert.equal(timeouts, 0);
    const pending = probeWithDeadline(
        () =>
            new Promise((_resolve, reject) => {
                rejectLate = reject;
            }),
        controller.signal,
        () => timeouts++,
    );
    await flush();
    t.mock.timers.tick(DISCOVERY_PROBE_TIMEOUT_MS);
    assert.equal(await pending, false);
    rejectLate(new Error("late failure"));
    await flush();
    assert.equal(timeouts, 1);
});

test("429s retry three times with exponential jitter and retain every catalog entry", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    t.mock.method(Math, "random", () => 0.5);
    const entries = ["first", "second", "third"].map((id) => ({ ...model(id), version: "company-reasoner-v1" }));
    const h = harness(entries);
    const starts = [];
    h.add("anthropic", async () => {
        starts.push(Date.now());
        throw new DiscoveryRetryableError({ status: 429 }, true);
    });
    const discovery = h.dispatcher.discoverModelsAndRegion();
    await flush();
    assert.deepEqual(starts, [0]);
    for (const delay of [1500, 3000, 6000]) {
        const before = starts.length;
        t.mock.timers.tick(delay - 1);
        await flush();
        assert.equal(starts.length, before);
        t.mock.timers.tick(1);
        await flush();
        assert.equal(starts.length, before + 1);
    }
    assert.deepEqual((await discovery).availableModels, entries);
    assert.deepEqual(starts, [0, 1500, 4500, 10500]);
    assert(logs.some((line) => line.includes("Retries exhausted; endpoint reachable (rate limited)")));
});

test("transient network failures retry and can recover, while permanent failures do not", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    t.mock.method(Math, "random", () => 0);
    const signal = new AbortController().signal;
    let calls = 0;
    const recovered = probeWithRetries(
        async () => {
            if (++calls < 3) throw new DiscoveryRetryableError(new Error("network timeout"), false);
            return true;
        },
        signal,
        () => assert.fail("unexpected timeout"),
        45_000,
        () => {},
    );
    await flush();
    t.mock.timers.tick(1000);
    await flush();
    t.mock.timers.tick(2000);
    assert.equal(await recovered, true);
    assert.equal(calls, 3);
    calls = 0;
    assert.equal(
        await probeWithRetries(
            async () => {
                calls++;
                return false;
            },
            signal,
            () => {},
            45_000,
            () => {},
        ),
        false,
    );
    assert.equal(calls, 1);
});

test("network retry exhaustion does not mark an unreachable endpoint available", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    t.mock.method(Math, "random", () => 0);
    let calls = 0;
    const pending = probeWithRetries(
        async () => {
            calls++;
            throw new DiscoveryRetryableError({ status: 503 }, false);
        },
        new AbortController().signal,
        () => {},
        45_000,
        () => {},
    );
    await flush();
    for (const delay of [1000, 2000, 4000]) {
        t.mock.timers.tick(delay);
        await flush();
    }
    assert.equal(await pending, false);
    assert.equal(calls, 4);
});

test("429 evidence survives a later hanging request at the shared deadline", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    t.mock.method(Math, "random", () => 0);
    let calls = 0,
        requestSignal,
        remainingBudget,
        timeoutReachable;
    const pending = probeWithRetries(
        async (options) => {
            requestSignal = options.signal;
            remainingBudget = options.timeoutMs;
            if (++calls === 1) throw new DiscoveryRetryableError({ status: 429 }, true);
            return never();
        },
        new AbortController().signal,
        (reachable) => {
            timeoutReachable = reachable;
        },
        5000,
        () => {},
    );
    await flush();
    t.mock.timers.tick(1000);
    await flush();
    assert.equal(remainingBudget, 4000);
    t.mock.timers.tick(4000);
    assert.equal(await pending, true);
    assert.equal(timeoutReachable, true);
    assert.equal(requestSignal.aborted, true);
    assert.equal(calls, 2);
});

test("Retry-After is honored within the deadline and cancellation interrupts backoff", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    t.mock.method(Math, "random", () => 0);
    const controller = new AbortController();
    let calls = 0;
    const pending = probeWithRetries(
        async () => {
            calls++;
            throw new DiscoveryRetryableError({ status: 429, headers: { "retry-after": "10" } }, true);
        },
        controller.signal,
        () => {},
        45_000,
        () => {},
    );
    await flush();
    t.mock.timers.tick(9999);
    await flush();
    assert.equal(calls, 1);
    controller.abort();
    assert.equal(await pending, false);
    t.mock.timers.tick(45_000);
    await flush();
    assert.equal(calls, 1);
});

test("an oversized Retry-After cannot extend the configured endpoint deadline", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const pending = probeWithRetries(
        async () => {
            throw new DiscoveryRetryableError({ status: 429, headers: { "retry-after": "999999999" } }, true);
        },
        new AbortController().signal,
        () => {},
        1000,
        () => {},
    );
    await flush();
    t.mock.timers.tick(1000);
    assert.equal(await pending, true);
});

test("the discovery queue staggers starts and never exceeds three active probes", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    t.mock.method(Math, "random", () => 0);
    const starts = [],
        completions = [];
    let active = 0,
        maximum = 0;
    const pending = runDiscoveryQueue(
        [0, 1, 2, 3, 4],
        (id) => {
            starts.push([id, Date.now()]);
            maximum = Math.max(maximum, ++active);
            return new Promise((resolve) => {
                completions[id] = () => {
                    active--;
                    resolve(id);
                };
            });
        },
        new AbortController().signal,
    );
    await flush();
    assert.deepEqual(starts, []);
    for (let i = 0; i < 3; i++) {
        t.mock.timers.tick(500);
        await flush();
    }
    assert.deepEqual(starts, [
        [0, 500],
        [1, 1000],
        [2, 1500],
    ]);
    t.mock.timers.tick(500);
    await flush();
    assert.equal(starts.length, 3);
    completions[0]();
    await flush();
    t.mock.timers.tick(500);
    await flush();
    completions[1]();
    await flush();
    t.mock.timers.tick(500);
    await flush();
    for (const id of [2, 3, 4]) completions[id]();
    assert.deepEqual(await pending, [0, 1, 2, 3, 4]);
    assert.equal(maximum, 3);
});

test("queued endpoints are not started after authentication failure", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const h = harness([model("bad-auth"), model("queued-1"), model("queued-2"), model("queued-3")]);
    h.dispatcher.discoveryStartDelayMs = () => 500;
    const requests = [];
    h.add("anthropic", async (id) => {
        requests.push(id);
        throw new VertexAuthenticationError("expired");
    });
    const rejected = assert.rejects(h.dispatcher.discoverModelsAndRegion(), VertexAuthenticationError);
    await flush();
    t.mock.timers.tick(500);
    await rejected;
    t.mock.timers.tick(45_000);
    await flush();
    assert.deepEqual(requests, ["bad-auth"]);
});

for (const [vendor, Provider, version] of [
    ["anthropic", VertexAnthropicProvider, "claude-opus-5-5"],
    ["google", VertexGoogleProvider, "gemini-3.8-flash"],
    ["grok", VertexGrokProvider, "xai/grok-4.6"],
]) {
    function providerWith(request) {
        const provider = new Provider();
        provider.region = "global";
        const client = { messages: { create: request }, models: { generateContent: request }, chat: { completions: { create: request } } };
        provider.client = client;
        provider.getClient = async () => client;
        return provider;
    }

    test(`${vendor} discovery rejects transport failures and preserves rate-limit/auth handling`, async () => {
        for (const error of [new Error("network timeout"), { code: "ETIMEDOUT" }, { status: 502 }, { status: 503 }, new Error("fetch failed")]) {
            const provider = providerWith(async () => {
                throw error;
            });
            await assert.rejects(provider.pingModel(version), (error) => error instanceof DiscoveryRetryableError && !error.reachable);
        }
        await assert.rejects(
            providerWith(async () => {
                throw { status: 429 };
            }).pingModel(version),
            (error) => error instanceof DiscoveryRetryableError && error.reachable,
        );
        await assert.rejects(
            providerWith(async () => {
                throw { status: 401 };
            }).pingModel(version),
            VertexAuthenticationError,
        );
        for (const status of [400, 403, 404]) {
            assert.equal(
                await providerWith(async () => {
                    throw { status };
                }).pingModel(version),
                false,
            );
        }
        assert.equal(
            await providerWith(async () => {
                throw { status: 403, message: "Quota project access denied" };
            }).pingModel(version),
            false,
        );
        await assert.rejects(
            providerWith(async () => {
                throw { status: "429" };
            }).pingModel(version),
            (error) => error.reachable,
        );
        await assert.rejects(
            providerWith(async () => {
                throw new Error('{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}');
            }).pingModel(version),
            (error) => error.reachable,
        );
    });

    test(`${vendor} discovery sends a deadline and cancellation signal without SDK retries`, async () => {
        const controller = new AbortController();
        let options;
        const provider = providerWith(async (body, requestOptions) => {
            options = vendor === "google" ? body.config : requestOptions;
        });
        assert.equal(await provider.pingModel(version, { signal: controller.signal, timeoutMs: 1234 }), true);
        if (vendor === "google") {
            assert.equal(options.abortSignal, controller.signal);
            assert.equal(options.httpOptions.timeout, 1234);
            assert.equal(options.httpOptions.retryOptions.attempts, 1);
        } else {
            assert.equal(options.signal, controller.signal);
            assert.equal(options.timeout, 1234);
            assert.equal(options.maxRetries, 0);
        }
        controller.abort();
        assert.equal(await provider.pingModel(version, { signal: controller.signal, timeoutMs: 1234 }), false);
    });

    test(`${vendor} discovery probes the literal backend without effort parameters`, async () => {
        let request;
        const provider = providerWith(async (body) => {
            request = body;
        });
        assert.equal(await provider.pingModel(version), true);
        assert.equal(request.model, version);
        assert.equal(Object.hasOwn(request, "reasoning_effort"), false);
        assert.equal(Object.hasOwn(request, "thinking"), false);
        assert.equal(Object.hasOwn(request, "output_config"), false);
        assert.equal(Object.hasOwn(request.config ?? {}, "thinkingConfig"), false);
    });

    test(`${vendor} discovery suppresses late success after cancellation`, async () => {
        const controller = new AbortController();
        const provider = providerWith(async () => {
            controller.abort();
        });
        assert.equal(await provider.pingModel(version, { signal: controller.signal, timeoutMs: 1234 }), false);
    });
}
