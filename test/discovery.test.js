const assert = require("node:assert/strict");
const Module = require("node:module");
const test = require("node:test");

const logs = [];
class Logger { log(message) { logs.push(message); } error(message) { logs.push(message); } }
class CancellationError extends Error {}
const vscode = {
  CancellationError,
  EventEmitter: class { event = () => ({ dispose() {} }); fire() {} },
  version: "1.120.0",
  workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback, inspect: () => ({}) }) },
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
const { DISCOVERY_PROBE_TIMEOUT_MS, probeWithDeadline } = require("../out/utils/discovery.js");
const { VertexAuthenticationError } = require("../out/utils/retry.js");
const catalogModel = require("../src/models.json").candidateModels[0];
const model = (id, vendor = "anthropic") => ({ ...catalogModel, id, version: id, vendor });
const flush = () => new Promise((resolve) => setImmediate(resolve));
const never = () => new Promise(() => {});
const emptyUsage = { usage: { input: 0, output: 0 }, charCount: {} };

function cancellation() {
  const listeners = new Set();
  const token = {
    isCancellationRequested: false,
    onCancellationRequested(fn) { listeners.add(fn); return { dispose: () => listeners.delete(fn) }; },
  };
  return {
    token, listeners,
    cancel() { token.isCancellationRequested = true; for (const fn of listeners) fn(); },
  };
}

function harness(models, regions = ["global"]) {
  // Skip SDK initialization: discovery uses fake providers and never calls the network.
  class Dispatcher extends VertexChatModelDispatcher { registerProviders() {} }
  const catalog = { getEffectiveCatalog: async () => ({ candidateModels: models, regionPriority: regions }) };
  const auth = { onAuthUpdated() {}, getResolvedAuthOptions: async () => undefined };
  const dispatcher = new Dispatcher("test-project", {}, auth, catalog);
  return { dispatcher, add(vendor, pingModel, inference = async () => emptyUsage) {
    const provider = { vendor, initialize(_project, region) { this.region = region; }, setLabels() {}, pingModel,
      provideLanguageModelChatResponse: inference };
    dispatcher.activeProviders.set(vendor, provider);
    return provider;
  } };
}

test("a stuck probe times out, aborts, and unblocks healthy-model inference", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness([model("healthy"), model("slow", "grok")]);
  let called = false, slowSignal;
  h.add("anthropic", async () => true, async () => { called = true; return emptyUsage; });
  h.add("grok", async (_id, { signal }) => { slowSignal = signal; return never(); });
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
  assert.deepEqual(result.availableModels.map((m) => m.id), ["healthy"]);
  assert.equal(called, true);
  assert.equal(slowSignal.aborted, true);
  assert.equal(h.dispatcher._discoveryPromise, null);
  assert.equal(chat.listeners.size, 0);
  assert(logs.some((line) => line.includes("Ping timed out for slow in global")));
});

test("timed-out regions advance and late probe success cannot change the chosen region", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness([model("healthy")], ["global", "europe-west1"]);
  let finishLate, oldSignal;
  h.add("anthropic", function (_id, { signal }) {
    if (this.region === "global") {
      oldSignal = signal;
      return new Promise((resolve) => { finishLate = resolve; });
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
  assert.equal((await h.dispatcher.provideLanguageModelChatInformation()).length, 1);
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
  h.add("anthropic", (_id, options) => { signal = options.signal; return new Promise((resolve) => { finishProbe = resolve; }); });
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
  h.add("anthropic", async () => { throw new VertexAuthenticationError("expired"); });
  h.add("grok", (_id, options) => { signal = options.signal; return never(); });
  await assert.rejects(h.dispatcher.discoverModelsAndRegion(), VertexAuthenticationError);
  assert.equal(signal.aborted, true);
  assert.equal(h.dispatcher._discoveryPromise, null);
});

test("probe timers are cleared after success and late rejection is handled", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const controller = new AbortController();
  let timeouts = 0, rejectLate;
  assert.equal(await probeWithDeadline(async () => true, controller.signal, () => timeouts++), true);
  t.mock.timers.tick(DISCOVERY_PROBE_TIMEOUT_MS);
  assert.equal(timeouts, 0);
  const pending = probeWithDeadline(() => new Promise((_resolve, reject) => { rejectLate = reject; }), controller.signal, () => timeouts++);
  await flush();
  t.mock.timers.tick(DISCOVERY_PROBE_TIMEOUT_MS);
  assert.equal(await pending, false);
  rejectLate(new Error("late failure"));
  await flush();
  assert.equal(timeouts, 1);
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
      const provider = providerWith(async () => { throw error; });
      assert.equal(await provider.pingModel(version), false);
    }
    assert.equal(await providerWith(async () => { throw { status: 429 }; }).pingModel(version), true);
    await assert.rejects(providerWith(async () => { throw { status: 401 }; }).pingModel(version), VertexAuthenticationError);
  });

  test(`${vendor} discovery sends a deadline and cancellation signal without SDK retries`, async () => {
    const controller = new AbortController();
    let options;
    const provider = providerWith(async (body, requestOptions) => { options = vendor === "google" ? body.config : requestOptions; });
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

  test(`${vendor} discovery suppresses late success after cancellation`, async () => {
    const controller = new AbortController();
    const provider = providerWith(async () => { controller.abort(); });
    assert.equal(await provider.pingModel(version, { signal: controller.signal, timeoutMs: 1234 }), false);
  });
}
