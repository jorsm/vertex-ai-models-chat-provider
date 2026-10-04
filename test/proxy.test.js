const assert = require("node:assert/strict");
const test = require("node:test");
const Module = require("node:module");
const settings = {};
const inspections = {};
const logs = [];
class TextPart { constructor(value) { this.value = value; } }
class ToolCallPart { constructor(callId, name, input) { Object.assign(this, { callId, name, input }); } }
class ToolResultPart { constructor(callId, content) { Object.assign(this, { callId, content }); } }
class DataPart { constructor(data, mimeType) { Object.assign(this, { data, mimeType }); } }
class CancellationError extends Error {}
const rootA = { fsPath: "/a" }, rootB = { fsPath: "/b" };
let sourceDisposed = false;
const vscode = {
  StatusBarAlignment: { Right: 1 },
  MarkdownString: class { value = ""; appendMarkdown(value) { this.value += value; } },
  extensions: {}, ProgressLocation: { Notification: 1 },
  CancellationTokenSource: class {
    constructor() { this.source = cancellation(); this.token = this.source.token; }
    cancel() { this.source.cancel(); }
    dispose() { sourceDisposed = true; }
  },
  LanguageModelChatMessage: class {
    constructor(role, content) { this.role = role; this.content = [new TextPart(content)]; }
    static User(content) { return new this(1, content); }
  },
  CancellationError, LanguageModelTextPart: TextPart, LanguageModelToolCallPart: ToolCallPart,
  LanguageModelToolResultPart: ToolResultPart, LanguageModelDataPart: DataPart,
  LanguageModelChatMessageRole: { User: 1, Assistant: 2 }, LanguageModelChatToolMode: { Auto: 1 },
  EventEmitter: class { event = () => ({ dispose() {} }); fire() {} dispose() {} }, version: "1.120.0",
  workspace: {
    name: "workspace", workspaceFolders: [{ name: "a", uri: rootA }, { name: "b", uri: rootB }],
    getWorkspaceFolder: (uri) => ({ name: uri === rootB ? "b" : "a" }),
    getConfiguration: (_section, uri) => ({
      get: (key, fallback) => settings[key] ?? fallback,
      inspect: (key) => key === "projectLabelValue" && uri === rootB
        ? { workspaceFolderValue: "repository-b", workspaceValue: "wrong-workspace" } : inspections[key] ?? {},
    }),
  },
  window: { activeTextEditor: { document: { uri: rootA } }, showWarningMessage() {}, showErrorMessage() {} },
};
let credentialCommand;
let commandResult;
let credentialCommandCount = 0;
const originalLoad = Module._load;
let AuthManager, ProxyGateway, GatewayError, validateProxyUrl, parseProxyCatalog, isGatewayRetryable, ModelCatalogResolver, UsageTrackerService;
let VertexChatModelDispatcher, VertexGoogleProvider, VertexAnthropicProvider, CostStatusBar;
let generateCommitMessage;
try {
  Module._load = function(request, parent, main) {
    if (request === "vscode") return vscode;
    if (request.endsWith("/Logger")) return { Logger: class { log(v) { logs.push(v); } error(v) { logs.push(v); } } };
    if (request === "child_process") {
      const actual = originalLoad.call(this, request, parent, main);
      const execFile = (...args) => {
        credentialCommandCount++;
        credentialCommand = args.slice(0, -1);
        const cb = args.at(-1);
        if (commandResult instanceof Error) cb(commandResult);
        else cb(null, commandResult, "");
      };
      execFile[require("node:util").promisify.custom] = async (...args) => {
        credentialCommandCount++;
        credentialCommand = args;
        if (commandResult instanceof Error) throw commandResult;
        if (typeof commandResult === "function") return commandResult(...args);
        return { stdout: commandResult, stderr: "" };
      };
      return { ...actual, execFile };
    }
    return originalLoad.call(this, request, parent, main);
  };
  ({ AuthManager } = require("../out/AuthManager.js"));
  ({ ProxyGateway, GatewayError, validateProxyUrl, parseProxyCatalog, isGatewayRetryable } = require("../out/ProxyGateway.js"));
  ({ ModelCatalogResolver } = require("../out/ModelCatalogResolver.js"));
  ({ UsageTrackerService } = require("../out/UsageTrackerService.js"));
  ({ CostStatusBar } = require("../out/CostStatusBar.js"));
  ({ VertexChatModelDispatcher } = require("../out/VertexChatModelDispatcher.js"));
  ({ VertexGoogleProvider } = require("../out/providers/VertexGoogleProvider.js"));
  ({ VertexAnthropicProvider } = require("../out/providers/VertexAnthropicProvider.js"));
  ({ generateCommitMessage } = require("../out/CommitMessage.js"));
} finally { Module._load = originalLoad; }
const { withRetry } = require("../out/utils/retry.js");
const catalog = require("../src/models.json");
const model = (id, vendor = "google", version = id) => ({ ...catalog.candidateModels[0], id, version, vendor });
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const flush = () => new Promise(setImmediate);
function cancellation() {
  const listeners = new Set();
  const token = { isCancellationRequested: false, onCancellationRequested(fn) { listeners.add(fn); return { dispose: () => listeners.delete(fn) }; } };
  return { token, cancel() { token.isCancellationRequested = true; for (const fn of listeners) fn(); }, listeners };
}
const userMessage = () => [{ role: 1, content: [new TextPart("hello")] }];
const jwt = (claims = {}) => `header.${Buffer.from(JSON.stringify({ email: "developer@example.com", email_verified: true, exp: Date.now()/1000 + 3600, ...claims })).toString("base64url")}.signature`;
test.afterEach(() => {
  for (const key of Object.keys(settings)) delete settings[key];
  for (const key of Object.keys(inspections)) delete inspections[key];
  credentialCommandCount = 0;
  commandResult = undefined;
});

test("proxy URL validates HTTPS, optional base path and loopback; rejects token/query/arbitrary schemes", () => {
  assert.equal(validateProxyUrl("https://gateway.test/proxy/"), "https://gateway.test/proxy");
  assert.equal(validateProxyUrl("http://127.0.0.1:8080"), "http://127.0.0.1:8080");
  for (const url of ["http://public.test", "https://user:pass@gateway.test", "https://gateway.test/?token=secret", "https://gateway.test/#token", "file:///tmp/x", "relative"]) {
    assert.throws(() => validateProxyUrl(url), GatewayError);
  }
});
test("only user settings select a credential destination; workspace override is ignored", () => {
  class Dispatcher extends VertexChatModelDispatcher { registerProviders() {} }
  const d = new Dispatcher("", {}, { onAuthUpdated() {} }, {});
  inspections.proxyUrl = { workspaceValue: "https://evil.test" };
  assert.equal(d.getProxyUrl(), "");
  inspections.proxyUrl.globalValue = "https://trusted.test";
  assert.equal(d.getProxyUrl(), "https://trusted.test");
});
test("token acquisition uses a bounded personal CLI command, caches briefly and refreshes explicitly", async () => {
  const auth = new AuthManager({});
  commandResult = jwt();
  const first = await auth.getProxyIdToken();
  assert.equal(first, commandResult);
  assert.equal(credentialCommand[2].timeout, 60_000);
  assert.equal(credentialCommand[2].env.CLOUDSDK_CORE_LOG_HTTP, "false");
  assert.ok(!credentialCommand[1].join(" ").includes("--audiences"));
  commandResult = jwt({ sub: "next" });
  assert.equal(await auth.getProxyIdToken(), first);
  auth.clearProxyToken();
  assert.equal(await auth.getProxyIdToken(), commandResult);
});
test("token acquisition rejects SA, expired, unverified and malformed tokens without exposing stderr", async () => {
  for (const output of [jwt({ email: "service@project.iam.gserviceaccount.com" }), jwt({ email_verified: false }), jwt({ exp: 1 }), "not-a-token", new Error("Authorization: Bearer secret")]) {
    commandResult = output;
    const auth = new AuthManager({});
    await assert.rejects(auth.getProxyIdToken(), (error) => error.status === 401 && !error.message.includes("secret"));
  }
});
test("client identity resolution is shared and caches the last successful gcloud account", async () => {
  const auth = new AuthManager({ workspaceState: { get: () => undefined } });
  commandResult = "developer@example.com\n";
  assert.equal(await auth.getIdentity(), "developer@example.com");
  commandResult = new Error("temporary gcloud failure");
  assert.equal(await auth.getIdentity(), "developer@example.com");
  assert.equal(credentialCommandCount, 1);
});
test("client identity and proxy token gcloud commands are serialized", async () => {
  const auth = new AuthManager({ workspaceState: { get: () => undefined } });
  const firstStarted = deferred();
  const releaseFirst = deferred();
  const expectedToken = jwt();
  let active = 0;
  let maxActive = 0;
  let invocation = 0;
  commandResult = async (_executable, args) => {
    active++;
    maxActive = Math.max(maxActive, active);
    if (++invocation === 1) {
      firstStarted.resolve();
      await releaseFirst.promise;
    }
    const stdout = args.join(" ").includes("print-identity-token") ? expectedToken : "developer@example.com\n";
    active--;
    return { stdout, stderr: "" };
  };

  const identity = auth.getIdentity();
  await firstStarted.promise;
  const token = auth.getProxyIdToken();
  await flush();
  assert.equal(maxActive, 1);
  releaseFirst.resolve();
  assert.equal(await identity, "developer@example.com");
  assert.equal(await token, expectedToken);
  assert.equal(maxActive, 1);
});
test("server catalog supplies complete metadata and validates IDs, prices, limits, capabilities and duplicates", () => {
  const entry = model("server-only-high", "google", "backend-high");
  assert.deepEqual(parseProxyCatalog({ models: [entry] }), [entry]);
  assert.deepEqual(parseProxyCatalog({ candidateModels: [entry], regionPriority: ["global"] }), [entry]);
  assert.deepEqual(parseProxyCatalog({ candidateModels: [], regionPriority: [] }), []);
  for (const invalid of [model("https://evil.test"), model("grok", "grok"), { ...entry, version: "projects/elsewhere" },
    { ...entry, pricing: { input: -1, output: 1 } }, { ...entry, pricing: { input: 1, output: Infinity } },
    { ...entry, maxOutputTokens: 0 }, { ...entry, capabilities: {} }, { id: "incomplete", vendor: "google" },
    { ...entry, pricing: { input: 1, output: 2, longContext: { input: 3, output: 4, inputThresholdTokens: -1 } } }]) {
    assert.throws(() => parseProxyCatalog({ models: [invalid] }), GatewayError);
  }
  for (const payload of [{}, { models: null }, { models: [entry, entry] }, { candidateModels: [entry] },
    { candidateModels: [entry], regionPriority: ["https://elsewhere"] },
    { candidateModels: [entry], regionPriority: [], models: [] },
    { candidateModels: [{ id: "incomplete" }], regionPriority: ["global"] }]) assert.throws(() => parseProxyCatalog(payload), GatewayError);
});
test("authenticated discovery sends only an ID token and bounds a stalled credential provider", async () => {
  const calls = [];
  const gateway = new ProxyGateway("https://gateway.test/base", async () => "personal-token", async (url, init) => {
    calls.push([url, init]); return Response.json({ candidateModels: [], regionPriority: ["global"] });
  });
  assert.deepEqual(await gateway.discover(100), []);
  assert.equal(calls[0][0], "https://gateway.test/base/discovery");
  assert.equal(new Headers(calls[0][1].headers).get("Authorization"), "Bearer personal-token");
  assert.equal(calls[0][1].body, undefined);
  assert.equal(calls[0][1].redirect, "error");
  await assert.rejects(new ProxyGateway("https://gateway.test", () => new Promise(() => {})).discover(5), /timed out/);
});
test("gateway transport rejects another origin/base path and removes quota/API-key headers", async () => {
  let headers;
  const gateway = new ProxyGateway("https://gateway.test/base", async () => "token", async (_url, init) => { headers = init.headers; return Response.json({}); });
  await assert.rejects(gateway.fetch("https://other.test/base"), /another destination/);
  await assert.rejects(gateway.fetch("https://gateway.test/elsewhere"), /another destination/);
  await gateway.fetch("https://gateway.test/base/v1/models", { headers: { "x-goog-user-project": "personal-project", "x-goog-api-key": "key" } });
  assert.equal(headers.get("x-goog-user-project"), null);
  assert.equal(headers.get("x-goog-api-key"), null);
});
test("canonical discovery failures never try another endpoint or catalog source", async () => {
  for (const status of [401, 403, 404, 500]) {
    const calls = [];
    const gateway = new ProxyGateway("https://gateway.test/base", async () => "token", async (url) => {
      calls.push(url);
      return Response.json({ error: { code: status } }, { status });
    });
    await assert.rejects(gateway.discover(100), (error) => error instanceof GatewayError && error.status === status);
    assert.deepEqual(calls, ["https://gateway.test/base/discovery"]);
  }
});
test("policy and caller/upstream authentication errors never retry even with quota-like text", async () => {
  for (const status of [400, 401, 403, 404, 413, 502]) {
    let calls = 0;
    await assert.rejects(withRetry(async () => { calls++; throw { status, message: "quota temporarily unavailable 503" }; }, { shouldRetry: isGatewayRetryable, maxRetries: 2 }));
    assert.equal(calls, 1);
  }
  assert.equal(isGatewayRetryable({ status: 429 }), true);
  assert.equal(isGatewayRetryable({ status: 503 }), true);
});

function harness(models, authOverrides = {}) {
  class Dispatcher extends VertexChatModelDispatcher { registerProviders() {} }
  const records = [], calls = [];
  const auth = { onAuthUpdated() {}, getProxyIdToken: async () => "personal-token", getResolvedAuthOptions: async () => { throw Error("must not resolve Vertex credentials"); }, getIdentity: async () => "developer@example.com", ...authOverrides };
  let proxyCatalog;
  const resolver = {
    setProxyCatalog(value) { proxyCatalog = value === undefined ? undefined : { candidateModels: value, regionPriority: [] }; },
    getEffectiveCatalog: async () => proxyCatalog ?? { candidateModels: models, regionPriority: ["forbidden-client-region"] },
  };
  const dispatcher = new Dispatcher("", { recordUsage: async (...args) => records.push(args) }, auth, resolver);
  for (const vendor of ["google", "anthropic", "grok"]) {
    dispatcher.activeProviders.set(vendor, {
      vendor, initialize(...args) { calls.push(["initialize", vendor, ...args]); }, setLabels() {},
      getDiscoveryModelId: (id) => id.replace(/-high$/, ""), pingModel() { throw Error("no inference probes allowed"); },
      provideLanguageModelChatResponse: async (...args) => { calls.push(["infer", vendor, ...args]); return { usage: { input: 1, output: 2, cache_read: 0, cache_create: 0 }, charCount: {} }; },
    });
  }
  return { dispatcher, calls, records, auth, resolver };
}
function fakeDiscovery(t, allowed, status = 200) {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, init) => { calls.push([url, init]); return Response.json({ models: allowed.map((entry) => ({ ...model(entry.id, entry.vendor), ...entry })) }, { status }); };
  t.after(() => { global.fetch = originalFetch; });
  return calls;
}
test("proxy dispatcher uses the server catalog and sends only an explicit custom user label", async (t) => {
  inspections.proxyUrl = { globalValue: "https://gateway.test" };
  settings.enableUserLabel = true;
  settings.userLabelValue = "Custom.User@example.com";
  const remote = [model("gemini-test"), { ...model("remote-high", "google", "backend-high"), displayName: "Remote effort", pricing: { input: 10, output: 20 } }];
  const requests = fakeDiscovery(t, remote);
  const h = harness([model("denied"), model("grok", "grok")]);
  h.resolver.getEffectiveCatalog = async () => { throw new Error("must not read local catalog during proxy discovery"); };
  const result = await h.dispatcher.discoverModelsAndRegion();
  assert.deepEqual(result.availableModels, remote);
  h.resolver.getEffectiveCatalog = async () => ({ candidateModels: remote, regionPriority: [] });
  assert.equal(requests.length, 1);
  assert.equal(h.calls.filter((c) => c[0] === "initialize").length, 2);
  assert.ok(h.calls.every((c) => c[2] === "gateway" && c[3] === "global"));
  await h.dispatcher.infer("gemini-test", userMessage(), { tools: [] }, { report() {} }, cancellation().token);
  assert.deepEqual(h.calls.at(-1)[7], { "vscode-vertex-ai-user": "custom_user_example_com" });
  assert.equal(h.records.length, 1);
  assert.deepEqual(h.records[0][2], remote[0].pricing);
  const info = await h.dispatcher.provideLanguageModelChatInformation();
  assert.equal(info[1].name, "Remote effort");
  assert.match(info[1].detail, /\$10 in/);
});
test("proxy user label falls back to the client Google identity when no custom value is set", async (t) => {
  inspections.proxyUrl = { globalValue: "https://gateway.test" };
  settings.enableUserLabel = true;
  const remote = [model("gemini-test")];
  fakeDiscovery(t, remote);
  const h = harness(remote);
  await h.dispatcher.discoverModelsAndRegion();
  await h.dispatcher.infer("gemini-test", userMessage(), { tools: [] }, { report() {} }, cancellation().token);
  assert.deepEqual(h.calls.at(-1)[7], {
    "vscode-vertex-ai-user": "developer_example_com",
  });
});
test("a request retries client identity resolution once when startup left the user label empty", async (t) => {
  inspections.proxyUrl = { globalValue: "https://gateway.test" };
  settings.enableUserLabel = true;
  let identityCalls = 0;
  const remote = [model("gemini-test")];
  fakeDiscovery(t, remote);
  const h = harness(remote, {
    getIdentity: async () => ++identityCalls === 1 ? undefined : "retry@example.com",
  });
  await h.dispatcher.discoverModelsAndRegion();
  await h.dispatcher.infer("gemini-test", userMessage(), { tools: [] }, { report() {} }, cancellation().token);
  assert.equal(identityCalls, 2);
  assert.deepEqual(h.calls.at(-1)[7], { "vscode-vertex-ai-user": "retry_example_com" });
});
test("a stale label refresh cannot overwrite a newer resolved client identity", async () => {
  settings.enableUserLabel = true;
  const first = deferred();
  const latest = deferred();
  let identityCalls = 0;
  class Dispatcher extends VertexChatModelDispatcher { registerProviders() {} }
  const dispatcher = new Dispatcher("", {}, {
    onAuthUpdated() {},
    getIdentity: () => ++identityCalls === 1 ? first.promise : latest.promise,
  }, { setProxyCatalog() {} });
  const applied = [];
  dispatcher.activeProviders.set("google", { setLabels: (labels) => applied.push(labels) });
  const newestUpdate = dispatcher.updateLabels();
  latest.resolve("new@example.com");
  await newestUpdate;
  first.resolve("old@example.com");
  await flush();
  assert.equal(dispatcher.cachedUserEmail, "new@example.com");
  assert.deepEqual(applied.at(-1), { "vscode-vertex-ai-user": "new_example_com" });
});
test("proxyUrl and projectId fail closed when both are configured", async () => {
  inspections.proxyUrl = { globalValue: "https://gateway.test" };
  const h = harness([model("denied")]);
  h.dispatcher.setProjectId("direct-project");
  await assert.rejects(
    h.dispatcher.discoverModelsAndRegion(),
    (error) => error instanceof GatewayError && /mutually exclusive/.test(error.message),
  );
  assert.deepEqual(await h.dispatcher.provideLanguageModelChatInformation(), []);
  assert.equal(h.calls.length, 0);
});
test("failed or empty server discovery never exposes the unfiltered local catalog", async (t) => {
  inspections.proxyUrl = { globalValue: "https://gateway.test" };
  const h = harness([model("denied")]);
  assert.deepEqual(await h.dispatcher.provideLanguageModelChatInformation(), []);
  fakeDiscovery(t, [], 403);
  await assert.rejects(h.dispatcher.discoverModelsAndRegion(), (e) => e.status === 403);
  assert.deepEqual(await h.dispatcher.provideLanguageModelChatInformation(), []);
  await assert.rejects(h.dispatcher.infer("denied", [], {}, {}, cancellation().token), /Model not available/);
  assert.equal(h.calls.length, 0);
});
test("commit inference resolves the target repository labels and records usage only once", async (t) => {
  inspections.proxyUrl = { globalValue: "https://gateway.test" };
  settings.enableProjectLabel = true;
  fakeDiscovery(t, [{ id: "gemini-test", vendor: "google" }]);
  const h = harness([model("gemini-test")]);
  await h.dispatcher.inferCommit([], { tools: [] }, { report() {} }, cancellation().token, rootB);
  const request = h.calls.find((c) => c[0] === "infer");
  assert.deepEqual(request[7], { "vscode-vertex-ai-project": "repository-b" });
  assert.equal(h.records.length, 1);
});
test("commit inference retries discovery after a previous empty error state", async (t) => {
  inspections.proxyUrl = { globalValue: "https://gateway.test" };
  const h = harness([model("local-denied")]);
  h.dispatcher.clearModels();
  const requests = fakeDiscovery(t, [model("gemini-3.8-flash")]);
  await h.dispatcher.inferCommit([], { tools: [] }, { report() {} }, cancellation().token, rootB);
  assert.equal(requests.length, 1);
  assert.equal(h.calls.find((call) => call[0] === "infer")[2], "gemini-3.8-flash");
});
test("commit inference uses a repository-configured authorized model", async (t) => {
  inspections.proxyUrl = { globalValue: "https://gateway.test" };
  settings.commitMessageModel = "claude-sonnet-5-5-medium";
  const remote = [model("gemini-3.8-flash"), model("claude-sonnet-5-5-medium", "anthropic")];
  fakeDiscovery(t, remote);
  const h = harness(remote);
  await h.dispatcher.inferCommit([], { tools: [] }, { report() {} }, cancellation().token, rootB);
  const request = h.calls.find((call) => call[0] === "infer");
  assert.equal(request[1], "anthropic");
  assert.equal(request[2], "claude-sonnet-5-5-medium");
});
test("commit inference rejects a configured model that discovery did not authorize", async (t) => {
  inspections.proxyUrl = { globalValue: "https://gateway.test" };
  settings.commitMessageModel = "gemini-disabled";
  const remote = [model("gemini-3.8-flash")];
  fakeDiscovery(t, remote);
  const h = harness(remote);
  await assert.rejects(
    h.dispatcher.inferCommit([], { tools: [] }, { report() {} }, cancellation().token, rootB),
    /not available or authorized/,
  );
  assert.equal(h.calls.filter((call) => call[0] === "infer").length, 0);
});
test("configuration reset aborts in-flight discovery and a late result cannot publish stale models", async (t) => {
  inspections.proxyUrl = { globalValue: "https://gateway.test" };
  const originalFetch = global.fetch;
  const pending = deferred();
  global.fetch = async () => pending.promise;
  t.after(() => { global.fetch = originalFetch; });
  const h = harness([model("gemini-test")]);
  const old = h.dispatcher.discoverModelsAndRegion();
  await flush();
  h.dispatcher.resetConnection();
  pending.resolve(Response.json({ models: [model("gemini-test")] }));
  await assert.rejects(old);
  assert.deepEqual(await h.dispatcher.provideLanguageModelChatInformation(), []);
});

function streamingFetch(t, events, gate) {
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (url, init) => {
    requests.push({ url: String(url), init, body: JSON.parse(init.body) });
    const encoder = new TextEncoder();
    const body = new ReadableStream({
      async start(controller) {
        const onAbort = () => { try { controller.error(new Error("aborted")); } catch {} };
        init.signal?.addEventListener("abort", onAbort, { once: true });
        try {
          for (let i=0; i<events.length; i++) {
            if (i === 1 && gate) await gate.promise;
            if (init.signal?.aborted) return;
            controller.enqueue(encoder.encode(events[i]));
          }
          controller.close();
        } finally { init.signal?.removeEventListener("abort", onAbort); }
      },
    });
    return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
  };
  t.after(() => { global.fetch = originalFetch; });
  return requests;
}
const geminiEvent = (data) => `data: ${JSON.stringify(data)}\n\n`;
const claudeEvent = (data) => `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`;
test("pinned Gemini SDK sends ID-token Vertex wire format and delivers output before EOF", async (t) => {
  const gate = deferred();
  const requests = streamingFetch(t, [
    geminiEvent({ candidates: [{ content: { role: "model", parts: [{ text: "first " }] } }] }),
    geminiEvent({ candidates: [{ content: { role: "model", parts: [{ text: "last" }] } }], usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 2, cachedContentTokenCount: 3 } }),
  ], gate);
  const provider = new VertexGoogleProvider();
  provider.initialize("gateway", "global", undefined, new ProxyGateway("https://gateway.test/base", async () => "personal-id-token"));
  const first = deferred(), parts = [];
  const resultPromise = provider.provideLanguageModelChatResponse("gemini-test", userMessage(), { tools: [] }, { report(p) { parts.push(p); if (p instanceof TextPart) first.resolve(); } }, cancellation().token, { "vscode-vertex-ai-project": "test-project" }, model("gemini-test"));
  await first.promise;
  assert.equal(parts[0].value, "first ");
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /^https:\/\/gateway.test\/base\/v1\/projects\/gateway\/locations\/global\/publishers\/google\/models\/gemini-test:streamGenerateContent\?alt=sse$/);
  assert.equal(new Headers(requests[0].init.headers).get("authorization"), "Bearer personal-id-token");
  assert.deepEqual(requests[0].body.labels, { "vscode-vertex-ai-project": "test-project" });
  gate.resolve();
  assert.deepEqual((await resultPromise).usage, { input: 4, output: 2, cache_read: 3, cache_create: 0 });
});
test("pinned Claude SDK uses gateway token, native SSE and label header, preserving signed continuation", async (t) => {
  const requests = streamingFetch(t, [
    claudeEvent({ type: "message_start", message: { id: "msg", role: "assistant", content: [], usage: { input_tokens: 5, output_tokens: 0 } } }),
    claudeEvent({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }),
    claudeEvent({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "private" } }),
    claudeEvent({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "signed" } }),
    claudeEvent({ type: "content_block_stop", index: 0 }),
    claudeEvent({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tool-1", name: "lookup", input: {} } }),
    claudeEvent({ type: "content_block_stop", index: 1 }),
    claudeEvent({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 2 } }),
    claudeEvent({ type: "message_stop" }),
  ]);
  const provider = new VertexAnthropicProvider();
  provider.initialize("gateway", "global", undefined, new ProxyGateway("https://gateway.test/base", async () => "personal-id-token"));
  const parts = [];
  const run = (messages) => provider.provideLanguageModelChatResponse("claude-test", messages, { tools: [] }, { report(p) { parts.push(p); } }, cancellation().token, { "vscode-vertex-ai-project": "project" }, model("claude-test", "anthropic"));
  assert.equal((await run(userMessage())).usage.input, 5);
  assert.match(requests[0].url, /\/base\/v1\/projects\/gateway\/locations\/global\/publishers\/anthropic\/models\/claude-test:streamRawPredict$/);
  const headers = new Headers(requests[0].init.headers);
  assert.equal(headers.get("authorization"), "Bearer personal-id-token");
  assert.deepEqual(JSON.parse(Buffer.from(headers.get("X-Vertex-AI-Labels"), "base64")), { "vscode-vertex-ai-project": "project" });
  assert.ok(!parts.some((p) => p.value?.includes("private")));
  await run([...userMessage(), { role: 2, content: [new ToolCallPart("tool-1", "lookup", {})] }, { role: 1, content: [new ToolResultPart("tool-1", [new TextPart("done")])] }]);
  assert.equal(requests[1].body.messages[1].content[0].signature, "signed");
});
test("Gemini cancellation during streaming aborts the actual SDK transport without retry", async (t) => {
  const gate = deferred();
  const requests = streamingFetch(t, [geminiEvent({ candidates: [{ content: { parts: [{ text: "first" }] } }] }), geminiEvent({})], gate);
  const provider = new VertexGoogleProvider();
  provider.initialize("gateway", "global", undefined, new ProxyGateway("https://gateway.test", async () => "token"));
  const cancel = cancellation(), first = deferred();
  const result = provider.provideLanguageModelChatResponse("gemini-test", userMessage(), { tools: [] }, { report() { first.resolve(); } }, cancel.token, {}, model("gemini-test"));
  await first.promise;
  cancel.cancel(); gate.resolve();
  await assert.rejects(result, CancellationError);
  assert.equal(requests[0].init.signal.aborted, true);
  assert.equal(requests.length, 1);
  assert.equal(cancel.listeners.size, 0);
});
test("partial Gemini stream failure preserves delivered text and does not restart generation", async (t) => {
  const originalFetch = global.fetch;
  let requests = 0, controller;
  const first = deferred();
  global.fetch = async () => { requests++; return new Response(new ReadableStream({ start(c) { controller = c; c.enqueue(new TextEncoder().encode(geminiEvent({ candidates: [{ content: { parts: [{ text: "partial" }] } }] }))); } }), { headers: { "Content-Type": "text/event-stream" } }); };
  t.after(() => { global.fetch = originalFetch; });
  const provider = new VertexGoogleProvider();
  provider.initialize("gateway", "global", undefined, new ProxyGateway("https://gateway.test", async () => "token"));
  const parts = [];
  const result = provider.provideLanguageModelChatResponse("gemini-test", userMessage(), { tools: [] }, { report(p) { parts.push(p); first.resolve(); } }, cancellation().token, {}, model("gemini-test"));
  await first.promise;
  controller.error(new Error("stream broken"));
  await assert.rejects(result);
  assert.equal(parts[0].value, "partial");
  assert.equal(requests, 1);
});

test("pinned Gemini SDK replays signed tool calls on the following gateway request", async (t) => {
  const requests = streamingFetch(t, [geminiEvent({ candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "lookup", args: { query: "value" } }, thoughtSignature: "gemini-signed" }] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } })]);
  const provider = new VertexGoogleProvider();
  provider.initialize("gateway", "global", undefined, new ProxyGateway("https://gateway.test", async () => "token"));
  const parts = [];
  const run = (messages) => provider.provideLanguageModelChatResponse("gemini-test", messages, { tools: [] }, { report(p) { parts.push(p); } }, cancellation().token, {}, model("gemini-test"));
  await run(userMessage());
  const call = parts.find((p) => p instanceof ToolCallPart);
  assert.ok(call);
  await run([...userMessage(), { role: 2, content: [call] }, { role: 1, content: [new ToolResultPart(call.callId, [new TextPart('{"value":42}')])] }]);
  assert.equal(requests[1].body.contents[1].parts[0].thoughtSignature, "gemini-signed");
  assert.equal(requests[1].body.contents[2].parts[0].functionResponse.name, "lookup");
});
for (const [vendor, Provider] of [["google", VertexGoogleProvider], ["anthropic", VertexAnthropicProvider]]) {
  test(`${vendor} SDK denies gateway 403 once; 401 remains a gateway error without ADC login classification`, async (t) => {
    const originalFetch = global.fetch;
    t.after(() => { global.fetch = originalFetch; });
    for (const status of [403, 401, 502]) {
      let calls = 0;
      global.fetch = async () => { calls++; return Response.json({ error: { code: status, message: "quota service unavailable", status: status === 502 ? "UPSTREAM_AUTHENTICATION_FAILED" : "PERMISSION_DENIED" } }, { status }); };
      const provider = new Provider();
      provider.initialize("gateway", "global", undefined, new ProxyGateway("https://gateway.test", async () => "token"));
      await assert.rejects(provider.provideLanguageModelChatResponse("model", userMessage(), { tools: [] }, { report() {} }, cancellation().token, {}, model("model", vendor)), (e) => e instanceof GatewayError && e.status === status);
      assert.equal(calls, 1);
    }
  });
  test(`${vendor} Stop before first chunk aborts SDK transport and cleans cancellation subscriptions`, async (t) => {
    const originalFetch = global.fetch;
    const entered = deferred();
    let signal;
    global.fetch = async (_url, init) => { signal = init.signal; entered.resolve(); return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })); };
    t.after(() => { global.fetch = originalFetch; });
    const provider = new Provider();
    provider.initialize("gateway", "global", undefined, new ProxyGateway("https://gateway.test", async () => "token"));
    const cancel = cancellation();
    const result = provider.provideLanguageModelChatResponse("model", userMessage(), { tools: [] }, { report() {} }, cancel.token, {}, model("model", vendor));
    await entered.promise;
    cancel.cancel();
    await assert.rejects(result, CancellationError);
    assert.equal(signal.aborted, true);
    assert.equal(cancel.listeners.size, 0);
  });
}
test("cancelling backoff is immediate and temporary failures recover without unbounded retry", async () => {
  let calls = 0;
  const cancel = cancellation();
  const entered = deferred();
  const promise = withRetry(async () => { calls++; entered.resolve(); throw { status: 429 }; }, { token: cancel.token, shouldRetry: isGatewayRetryable, retryDelayMs: () => 60_000, maxRetries: 2 });
  await entered.promise;
  await flush();
  cancel.cancel();
  await assert.rejects(promise, CancellationError);
  assert.equal(calls, 1);
  assert.equal(cancel.listeners.size, 0);
  const originalRandom = Math.random;
  Math.random = () => 0;
  try {
    let attempts = 0;
    assert.equal(await withRetry(async () => { if (++attempts < 3) throw { status: 503 }; return "ok"; }, { shouldRetry: isGatewayRetryable, baseDelayMs: 1, maxDelayMs: 1, maxRetries: 2 }), "ok");
    assert.equal(attempts, 3);
  } finally { Math.random = originalRandom; }
});
test("discovery rejects oversized, malformed and empty responses", async () => {
  for (const body of ["", "not-json", JSON.stringify({ models: [] }) + " ".repeat(1_048_576)]) {
    const gateway = new ProxyGateway("https://gateway.test", async () => "token", async () => new Response(body));
    await assert.rejects(gateway.discover(500), GatewayError);
  }
});

for (const [vendor, Provider] of [["google", VertexGoogleProvider], ["anthropic", VertexAnthropicProvider]]) {
  test(`${vendor} cancellation while acquiring credentials returns immediately and sends no late request`, async (t) => {
    const originalFetch = global.fetch;
    let calls = 0;
    global.fetch = async (_url, init) => { init.signal.throwIfAborted(); calls++; return Response.json({}); };
    t.after(() => { global.fetch = originalFetch; });
    const credentials = deferred(), entered = deferred();
    const provider = new Provider();
    provider.initialize("gateway", "global", undefined, new ProxyGateway("https://gateway.test", async () => { entered.resolve(); return credentials.promise; }));
    const cancel = cancellation();
    const result = provider.provideLanguageModelChatResponse("model", userMessage(), { tools: [] }, { report() {} }, cancel.token, {}, model("model", vendor));
    await entered.promise;
    cancel.cancel();
    await assert.rejects(result, CancellationError);
    credentials.resolve("token");
    await flush();
    assert.equal(calls, 0);
  });
}
test("brief token cache automatically refreshes after one minute", async () => {
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  try {
    const auth = new AuthManager({});
    commandResult = jwt({ sub: "first" });
    const first = await auth.getProxyIdToken();
    commandResult = jwt({ sub: "second" });
    now += 61_000;
    assert.notEqual(await auth.getProxyIdToken(), first);
  } finally { Date.now = originalNow; }
});
test("resetting proxy mode reinitializes direct providers instead of reusing gateway authentication", async (t) => {
  inspections.proxyUrl = { globalValue: "https://gateway.test" };
  fakeDiscovery(t, [{ id: "gemini-test", vendor: "google" }]);
  const h = harness([model("gemini-test")]);
  await h.dispatcher.discoverModelsAndRegion();
  const gateway = h.calls[0][5];
  delete inspections.proxyUrl;
  h.auth.getResolvedAuthOptions = async () => undefined;
  for (const provider of h.dispatcher.activeProviders.values()) provider.pingModel = async () => true;
  h.dispatcher.discoveryStartDelayMs = () => 0;
  h.dispatcher.setProjectId("personal-project");
  await h.dispatcher.discoverModelsAndRegion();
  assert.equal(gateway.signal.aborted, true);
  assert.ok(h.calls.some((c) => c[0] === "initialize" && c[2] === "personal-project" && c[5] === undefined));
});

test("late direct credentials cannot reinitialize providers after switching to the proxy", async (t) => {
  const h = harness([model("gemini-test")]);
  const credentials = deferred(), entered = deferred();
  h.auth.getResolvedAuthOptions = async () => { entered.resolve(); return credentials.promise; };
  h.dispatcher.setProjectId("direct-project");
  const old = h.dispatcher.discoverModelsAndRegion();
  await entered.promise;
  inspections.proxyUrl = { globalValue: "https://gateway.test" };
  h.dispatcher.setProjectId("");
  fakeDiscovery(t, [{ id: "gemini-test", vendor: "google" }]);
  await h.dispatcher.discoverModelsAndRegion();
  credentials.resolve(undefined);
  await assert.rejects(old, /Configuration changed/);
  assert.ok(h.calls.every((c) => c[0] !== "initialize" || c[2] === "gateway"));
  assert.equal((await h.dispatcher.provideLanguageModelChatInformation())[0].id, "gemini-test");
});
for (const method of ["infer", "inferCommit"]) {
  test(`${method} cancellation while initial discovery is pending returns without waiting for its timeout`, async () => {
    inspections.proxyUrl = { globalValue: "https://gateway.test" };
    const h = harness([model("gemini-test")]);
    const entered = deferred(), credentials = deferred();
    h.auth.getProxyIdToken = async () => { entered.resolve(); return credentials.promise; };
    const cancel = cancellation();
    const args = [[], { tools: [] }, { report() {} }, cancel.token, rootB];
    const promise = method === "infer" ? h.dispatcher.infer("gemini-test", ...args) : h.dispatcher.inferCommit(...args);
    await entered.promise;
    cancel.cancel();
    await assert.rejects(promise, CancellationError);
    assert.equal(cancel.listeners.size, 0);
    assert.equal(h.calls.length, 0);
    h.dispatcher.dispose();
    credentials.resolve("token");
    await flush();
  });
}
test("SCM command uses shared inference, target repository and cancellable progress", async (t) => {
  const originalWindow = { ...vscode.window };
  const originalGetExtension = vscode.extensions.getExtension;
  t.after(() => { Object.assign(vscode.window, originalWindow); vscode.extensions.getExtension = originalGetExtension; });
  sourceDisposed = false;
  const repo = { rootUri: rootB, state: { indexChanges: [{ uri: { fsPath: "/b/file.ts" } }] }, inputBox: { value: "" }, diffIndexWithHEAD: async () => "+code" };
  vscode.extensions.getExtension = () => ({ isActive: true, exports: { getAPI: () => ({ getRepository: () => repo }) } });
  let errors = 0;
  vscode.window.showErrorMessage = () => errors++;
  const progressCancel = cancellation();
  let progressOptions;
  vscode.window.withProgress = async (options, callback) => { progressOptions = options; return callback({}, progressCancel.token); };
  let count = 0;
  await generateCommitMessage({ async inferCommit(_messages, _options, progress, _token, resource) {
    count++; assert.equal(resource, rootB); progress.report(new TextPart("feat: change"));
  } }, rootB);
  assert.equal(repo.inputBox.value, "feat: change");
  assert.equal(count, 1);
  assert.equal(progressOptions.cancellable, true);
  assert.equal(progressCancel.listeners.size, 0);
  assert.equal(sourceDisposed, true);
  await generateCommitMessage({ async inferCommit(_messages, _options, _progress, token) {
    progressCancel.cancel(); assert.equal(token.isCancellationRequested, true); throw new CancellationError();
  } }, rootB);
  assert.equal(repo.inputBox.value, "");
  assert.equal(errors, 0);
  assert.equal(progressCancel.listeners.size, 0);
});

test("proxy catalog takes precedence for all consumers and an empty response never restores local models", async () => {
  const resolver = Object.create(ModelCatalogResolver.prototype);
  resolver.cached = { catalog: { candidateModels: [model("local")], regionPriority: ["global"] }, source: "bundled" };
  const remote = [{ ...model("server-only"), pricing: { input: 3, output: 9, cache_read: 1 } }];
  resolver.setProxyCatalog(remote);
  assert.equal(await resolver.getActiveSource(), "proxy");
  assert.deepEqual((await resolver.getEffectiveCatalog()).candidateModels, remote);
  const tracker = new UsageTrackerService({ globalStorageUri: { fsPath: "/tmp" } }, resolver);
  const tokens = { input: 1_000_000, output: 1_000_000, cache_read: 1_000_000, cache_create: 0, characters: {} };
  assert.equal(await tracker.calculateCost("server-only", tokens), 13);
  resolver.setProxyCatalog([]);
  assert.deepEqual((await resolver.getEffectiveCatalog()).candidateModels, []);
  assert.equal(await tracker.calculateCost("server-only", tokens, remote[0].pricing), 13);
  resolver.setProxyCatalog(undefined);
  assert.equal(await resolver.getActiveSource(), "bundled");
  assert.equal((await resolver.getEffectiveCatalog()).candidateModels[0].id, "local");
});
test("proxy status bar describes server catalog and personal login without resolving Vertex identity", async (t) => {
  inspections.proxyUrl = { globalValue: "https://gateway.test" };
  const original = vscode.window.createStatusBarItem;
  t.after(() => { vscode.window.createStatusBarItem = original; });
  const item = { show() {}, dispose() {} };
  vscode.window.createStatusBarItem = () => item;
  const subscribe = () => ({ dispose() {} });
  const bar = new CostStatusBar({ getTodayTotalCost: async () => 1.5, onUsageUpdated: subscribe },
    { getIdentity: async () => { throw new Error("must not resolve Vertex identity"); }, getActiveMethod: () => undefined, onAuthUpdated: subscribe },
    { getActiveSource: async () => "proxy" });
  await bar.updateStatusBar();
  assert.match(item.text, /\$1.50/);
  assert.match(item.tooltip.value, /Server Catalog/);
  assert.match(item.tooltip.value, /Managed by the proxy/);
  assert.match(item.tooltip.value, /personal gcloud login/);
  bar.dispose();
});

for (const [vendor, Provider] of [["google", VertexGoogleProvider], ["anthropic", VertexAnthropicProvider]]) {
  test(`${vendor} changing the gateway during streaming aborts the transport without sending further output`, async (t) => {
    const gate = deferred();
    const firstEvent = vendor === "google"
      ? geminiEvent({ candidates: [{ content: { parts: [{ text: "first" }] } }] })
      : claudeEvent({ type: "message_start", message: { id: "msg", role: "assistant", content: [], usage: { input_tokens: 1, output_tokens: 0 } } })
        + claudeEvent({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })
        + claudeEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "first" } });
    const requests = streamingFetch(t, [firstEvent, vendor === "google" ? geminiEvent({}) : claudeEvent({ type: "message_stop" })], gate);
    const gateway = new ProxyGateway("https://gateway.test", async () => "token");
    const provider = new Provider();
    provider.initialize("gateway", "global", undefined, gateway);
    const first = deferred(), parts = [];
    const result = provider.provideLanguageModelChatResponse("model", userMessage(), { tools: [] }, { report(p) { parts.push(p); first.resolve(); } }, cancellation().token, {}, model("model", vendor));
    await first.promise;
    gateway.dispose(); gate.resolve();
    await assert.rejects(result, CancellationError);
    assert.equal(requests[0].init.signal.aborted, true);
    assert.equal(requests.length, 1);
    assert.equal(parts.length, 1);
  });
}
test("partial Claude stream failure preserves delivered text and does not restart generation", async (t) => {
  const originalFetch = global.fetch;
  let requests = 0, controller;
  const first = deferred();
  const events = claudeEvent({ type: "message_start", message: { id: "msg", role: "assistant", content: [], usage: { input_tokens: 1, output_tokens: 0 } } })
    + claudeEvent({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })
    + claudeEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } });
  global.fetch = async () => { requests++; return new Response(new ReadableStream({ start(c) { controller = c; c.enqueue(new TextEncoder().encode(events)); } }), { headers: { "Content-Type": "text/event-stream" } }); };
  t.after(() => { global.fetch = originalFetch; });
  const provider = new VertexAnthropicProvider();
  provider.initialize("gateway", "global", undefined, new ProxyGateway("https://gateway.test", async () => "token"));
  const parts = [];
  const result = provider.provideLanguageModelChatResponse("claude-test", userMessage(), { tools: [] }, { report(p) { parts.push(p); first.resolve(); } }, cancellation().token, {}, model("claude-test", "anthropic"));
  await first.promise;
  controller.error(new Error("stream broken"));
  await assert.rejects(result);
  assert.equal(parts[0].value, "partial");
  assert.equal(requests, 1);
});
