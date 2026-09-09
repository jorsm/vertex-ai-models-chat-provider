const assert = require("node:assert/strict");
const Module = require("node:module");
const test = require("node:test");

class TextPart { constructor(value) { this.value = value; } }
class DataPart { constructor(data, mimeType) { Object.assign(this, { data, mimeType }); } }
class ToolCallPart { constructor(callId, name, input) { Object.assign(this, { callId, name, input }); } }
class ToolResultPart { constructor(callId, content) { Object.assign(this, { callId, content }); } }
const vscode = {
  LanguageModelTextPart: TextPart,
  LanguageModelDataPart: DataPart,
  LanguageModelToolCallPart: ToolCallPart,
  LanguageModelToolResultPart: ToolResultPart,
  LanguageModelChatMessageRole: { User: 1, Assistant: 2 },
  window: { createOutputChannel: () => ({ appendLine() {} }) },
  workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
};
const originalLoad = Module._load;
let VertexGrokProvider;
try {
  Module._load = function (request, parent, isMain) {
    if (request === "vscode") return vscode;
    return originalLoad.call(this, request, parent, isMain);
  };
  ({ VertexGrokProvider } = require("../out/providers/VertexGrokProvider.js"));
} finally {
  Module._load = originalLoad;
}
const catalog = require("../src/models.json");
const spec = catalog.candidateModels.find((model) => model.id === "grok-4.6");
const token = { isCancellationRequested: false };
const user = (content) => ({ role: 1, content });

function harness(chunks = []) {
  const provider = new VertexGrokProvider();
  provider.initialize("test-project", "global");
  provider.logger.log = () => {};
  const requests = [];
  provider.getClient = async () => ({ chat: { completions: { create: async (request) => {
    requests.push(request);
    return (async function* () { yield* chunks; })();
  } } } });
  const parts = [];
  return { provider, requests, parts, progress: { report: (part) => parts.push(part) } };
}

const chunk = (delta, finish_reason = null) => ({ choices: [{ index: 0, delta, finish_reason }] });

test("Grok 4.6 catalog uses the Vertex path, vision and tools", () => {
  assert.equal(spec.version, "xai/grok-4.6");
  assert.equal(spec.vendor, "grok");
  assert.equal(spec.maxInputTokens, 524288);
  assert.equal(spec.maxOutputTokens, 524288);
  assert.deepEqual(spec.capabilities, { imageInput: true, toolCalling: true });
  assert.equal(catalog.regionPriority[0], "global");
});

test("Grok 4.6 request sends image parts and asks for streaming usage", async () => {
  const h = harness([chunk({ content: "A red square." }, "stop"), {
    choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120,
      prompt_tokens_details: { cached_tokens: 40 } },
  }]);
  const result = await h.provider.provideLanguageModelChatResponse(spec.id,
    [user([new TextPart("Describe this"), new DataPart(Uint8Array.from([1, 2, 3]), "image/png")])],
    {}, h.progress, token, undefined, spec);
  const request = h.requests[0];
  assert.equal(request.model, "xai/grok-4.6");
  assert.equal(request.max_tokens, spec.maxOutputTokens);
  assert.equal(request.stream, true);
  assert.deepEqual(request.stream_options, { include_usage: true });
  assert.equal(Object.hasOwn(request, "reasoning_effort"), false);
  assert.deepEqual(request.messages[0].content, [
    { type: "text", text: "Describe this" },
    { type: "image_url", image_url: { url: "data:image/png;base64,AQID" } },
  ]);
  assert.equal(h.parts[0].value, "A red square.");
  assert.equal(result.usage.cache_read, 40);
  assert.equal(result.usage.output, 20);
  assert.equal(h.parts.at(-1).mimeType, "usage");
});

test("Grok streams parallel tool calls and maps results for the next turn", async () => {
  const h = harness([
    chunk({ tool_calls: [
      { index: 0, id: "call-1", function: { name: "lookup", arguments: '{"id":' } },
      { index: 1, id: "call-2", function: { name: "lookup", arguments: '{"id":2}' } },
    ] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: "1}" } }] }, "tool_calls"),
  ]);
  const options = { tools: [{ name: "lookup", description: "Look up an item", inputSchema: {
    type: "object", properties: { id: { type: "integer" } }, required: ["id"],
  } }] };
  const messages = [user([new TextPart("Look up items 1 and 2")])];
  await h.provider.provideLanguageModelChatResponse(spec.id, messages, options, h.progress, token, undefined, spec);
  const calls = h.parts.filter((part) => part instanceof ToolCallPart);
  assert.deepEqual(calls.map(({ callId, name, input }) => ({ callId, name, input })), [
    { callId: "call-1", name: "lookup", input: { id: 1 } },
    { callId: "call-2", name: "lookup", input: { id: 2 } },
  ]);
  assert.equal(h.requests[0].tool_choice, "auto");
  assert.deepEqual(h.requests[0].tools[0].function.parameters, options.tools[0].inputSchema);
  await h.provider.provideLanguageModelChatResponse(spec.id, [...messages,
    { role: 2, content: calls },
    user([new ToolResultPart("call-1", [new TextPart("one")]), new ToolResultPart("call-2", [new TextPart("two")])]),
  ], options, h.progress, token, undefined, spec);
  assert.deepEqual(h.requests[1].messages.slice(-2), [
    { role: "tool", tool_call_id: "call-1", content: "one" },
    { role: "tool", tool_call_id: "call-2", content: "two" },
  ]);
  assert.equal(h.requests[1].messages[1].tool_calls[0].function.arguments, '{"id":1}');
});

test("Grok discovery uses the API model path and skips regional endpoints", async () => {
  const h = harness();
  assert.equal(await h.provider.pingModel(spec.version), true);
  assert.equal(h.requests[0].model, "xai/grok-4.6");
  assert.equal(h.requests[0].max_tokens, 1);
  h.provider.initialize("test-project", "us-east5");
  assert.equal(await h.provider.pingModel(spec.version), false);
  await assert.rejects(h.provider.provideLanguageModelChatResponse(spec.id,
    [user([new TextPart("hi")])], {}, h.progress, token, undefined, spec), /global/);
  assert.equal(h.requests.length, 1);
});

test("removed non-Grok models are absent and cannot be discovered or invoked", async () => {
  const h = harness();
  assert.deepEqual(catalog.candidateModels.filter((model) => model.vendor === "grok").map((model) => model.id),
    ["grok-4.6", "grok-4.6-low", "grok-4.6-medium"]);
  for (const [id, version] of [
    ["qwen3-coder-480b", "qwen/qwen3-coder-480b-a35b-instruct-maas"],
    ["deepseek-v3.2", "deepseek-ai/deepseek-v3.2-maas"],
    ["kimi-k2-thinking", "moonshotai/kimi-k2-thinking-maas"],
    ["grok-4.2-reasoning", "xai/grok-4.20-reasoning"],
  ]) {
    assert.equal(await h.provider.pingModel(version), false);
    await assert.rejects(h.provider.provideLanguageModelChatResponse(id, [], {}, h.progress, token, undefined, spec), /Unknown Grok model/);
  }
  assert.equal(h.requests.length, 0);
});

test("Grok 4.6 efforts reach both inference and discovery without leaking suffixes", async () => {
  for (const effort of ["low", "medium", "high"]) {
    const h = harness();
    const alias = { ...spec, id: `${spec.id}-${effort}`, version: `${spec.version}-${effort}` };
    await h.provider.provideLanguageModelChatResponse(alias.id, [user([new TextPart("hi")])], {}, h.progress, token, undefined, alias);
    assert.equal(h.requests[0].model, "xai/grok-4.6");
    assert.equal(h.requests[0].reasoning_effort, effort);
    assert.equal(await h.provider.pingModel(alias.version), true);
    assert.equal(h.requests[1].model, "xai/grok-4.6");
    assert.equal(h.requests[1].reasoning_effort, effort);
    h.provider.initialize("test-project", "europe-west1");
    assert.equal(await h.provider.pingModel(alias.version), false);
    assert.equal(h.requests.length, 2);
  }
});

test("unsupported effort aliases fail before making an inference request", async () => {
  const h = harness();
  for (const id of ["grok-4.6-xhigh", "grok-4.6-max", "grok-4.6-none", "grok-4.2-reasoning-high", "deepseek-v3.2-high"]) {
    await assert.rejects(h.provider.provideLanguageModelChatResponse(id, [], {}, h.progress, token, undefined, spec), /Unknown Grok model/);
  }
  assert.equal(h.requests.length, 0);
});

test("Grok keeps the system prompt first without inserting a spurious user message", async () => {
  const h = harness();
  await h.provider.provideLanguageModelChatResponse(spec.id, [
    { role: 0, content: [new TextPart("Be concise.")] }, user([new TextPart("hi")]),
  ], {}, h.progress, token, undefined, spec);
  assert.deepEqual(h.requests[0].messages, [
    { role: "system", content: "Be concise." }, { role: "user", content: [{ type: "text", text: "hi" }] },
  ]);
});

test("Grok usage includes separately billed reasoning and avoids double-counting cache hits", async () => {
  for (const usage of [
    { prompt_tokens: 100, completion_tokens: 20, total_tokens: 170, completion_tokens_details: { reasoning_tokens: 50 } },
    { prompt_tokens: 100, completion_tokens: 70, total_tokens: 170, completion_tokens_details: { reasoning_tokens: 50 } },
    { prompt_tokens: 100, completion_tokens: 20, completion_tokens_details: { reasoning_tokens: 50 } },
  ]) {
    const h = harness([{ choices: [], usage: { ...usage, prompt_tokens_details: { cached_tokens: 40 } } }]);
    const result = await h.provider.provideLanguageModelChatResponse(spec.id, [user([new TextPart("hi")])], {}, h.progress, token, undefined, spec);
    assert.deepEqual(result.usage, { input: 60, output: 70, cache_read: 40, cache_create: 0 });
    const reported = JSON.parse(new TextDecoder().decode(h.parts.at(-1).data));
    assert.equal(reported.prompt_tokens, 100);
    assert.equal(reported.completion_tokens, 70);
    assert.equal(reported.total_tokens, 170);
  }
});

test("filters malformed Vertex keepalive data events before OpenAI stream parsing", async () => {
  const h = harness();
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode("data: : keep"));
      controller.enqueue(encoder.encode("alive\n\ndata: {\"choices\":[]}\n\n"));
      controller.close();
    },
  });
  const response = new Response(body, { headers: { "content-type": "text/event-stream" } });
  const filtered = h.provider.filterMalformedKeepaliveEvents(response);
  assert.equal(await filtered.text(), "\ndata: {\"choices\":[]}\n\n");
});

// Explicit opt-in: uses the selected project's billable Vertex endpoint and ADC.
// GOOGLE_APPLICATION_CREDENTIALS=/path/to/adc.json GROK46_LIVE_PROJECT=your-project \
//   node --test --test-name-pattern='live Grok' test/grok46.test.js
// Run npm run compile first.
test("live Grok 4.6 vision, streamed tool call and continuation", {
  skip: !process.env.GROK46_LIVE_PROJECT,
  timeout: 90000,
}, async () => {
  const h = harness();
  delete h.provider.getClient; // Use the actual authenticated OpenAI client.
  h.provider.initialize(process.env.GROK46_LIVE_PROJECT, "global");
  const liveSpec = { ...spec, maxOutputTokens: 512 };
  const redPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKElEQVR4nO3NMQEAAAjDMMC/ZzDBvlRA01vZJvwHAAAAAAAAAAAAbx2jxAE/i2AjOgAAAABJRU5ErkJggg==", "base64");
  const messages = [user([
    new TextPart("Call identify_color with the dominant color in this image. Wait for the tool result before answering."),
    new DataPart(redPng, "image/png"),
  ])];
  const options = { tools: [{ name: "identify_color", description: "Verify the color seen in an image", inputSchema: {
    type: "object", properties: { color: { type: "string", enum: ["red", "green", "blue"] } }, required: ["color"],
  } }] };
  const liveToken = { isCancellationRequested: false };
  const timer = setTimeout(() => { liveToken.isCancellationRequested = true; }, 60000);
  try {
    const first = await h.provider.provideLanguageModelChatResponse(spec.id, messages, options, h.progress, liveToken, undefined, liveSpec);
    const calls = h.parts.filter((part) => part instanceof ToolCallPart);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, "identify_color");
    assert.deepEqual(calls[0].input, { color: "red" });
    assert.ok(first.usage.output > 0);
    h.parts.length = 0;
    await h.provider.provideLanguageModelChatResponse(spec.id, [...messages,
      { role: 2, content: calls }, user([new ToolResultPart(calls[0].callId, [new TextPart("Verified: red. Tell the user the color.")])]),
    ], {}, h.progress, liveToken, undefined, liveSpec);
    assert.match(h.parts.filter((part) => part instanceof TextPart).map((part) => part.value).join(""), /red/i);
  } finally {
    clearTimeout(timer);
  }
});

test("live Grok 4.6 effort discovery", { skip: !process.env.GROK46_LIVE_PROJECT, timeout: 90000 }, async () => {
  const h = harness();
  delete h.provider.getClient;
  h.provider.initialize(process.env.GROK46_LIVE_PROJECT, "global");
  for (const effort of ["low", "medium", "high"]) {
    const alias = { ...spec, version: `${spec.version}-${effort}` };
    assert.equal(await h.provider.pingModel(alias.version), true, `${effort} discovery failed`);
  }
});
