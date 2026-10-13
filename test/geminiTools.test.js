const assert = require("node:assert/strict");
const test = require("node:test");
const Module = require("node:module");

class TextPart {
    constructor(value) {
        this.value = value;
    }
}
class ToolCallPart {
    constructor(callId, name, input) {
        Object.assign(this, { callId, name, input });
    }
}
class ToolResultPart {
    constructor(callId, content) {
        Object.assign(this, { callId, content });
    }
}
class DataPart {}
class CancellationError extends Error {}
const vscode = {
    LanguageModelTextPart: TextPart,
    LanguageModelToolCallPart: ToolCallPart,
    LanguageModelToolResultPart: ToolResultPart,
    LanguageModelDataPart: DataPart,
    LanguageModelChatMessageRole: { User: 1, Assistant: 2 },
    CancellationError,
};
const originalLoad = Module._load;
let processGeminiStream, GeminiMessages, isLeakedReasoningHeader, stripLeakedReasoningHeader;
try {
    Module._load = function (request, parent, main) {
        if (request === "vscode") return vscode;
        return originalLoad.call(this, request, parent, main);
    };
    ({ processGeminiStream } = require("../out/providers/google/GeminiStream.js"));
    ({ GeminiMessages, isLeakedReasoningHeader, stripLeakedReasoningHeader } = require("../out/providers/google/GeminiMessages.js"));
} finally {
    Module._load = originalLoad;
}

function createContext(actualId = "gemini-4-argon") {
    const parts = [];
    const context = {
        modelId: actualId,
        actualId,
        progress: { report: (part) => parts.push(part) },
        charCount: { system: 0, user_text: 0, assistant_text: 0, image: 0, tool_use: 0, tool_result: 0 },
        logger: { log() {} },
        signal: new AbortController().signal,
        thoughtSignatureCache: new Map(),
        apiToolCallIds: new Set(),
        textSignatureCache: new Map(),
        reasoningHeaders: { isLeakedReasoningHeader, stripLeakedReasoningHeader },
    };
    return { context, parts };
}

async function* chunks(...responses) {
    yield* responses;
}

function mapHistory(context, messages) {
    return new GeminiMessages(context.thoughtSignatureCache, context.textSignatureCache, context.reasoningHeaders, context.logger, context.apiToolCallIds).extractMessages(messages, context.charCount, context.modelId, context.actualId).mappedContents;
}

function toolChunk(parts, usageMetadata) {
    return {
        candidates: [{ content: { role: "model", parts } }],
        // Match the SDK getter, which exposes calls without the enclosing signature.
        functionCalls: parts.filter((part) => part.functionCall).map((part) => part.functionCall),
        usageMetadata,
    };
}

for (const modelId of [
    "gemini-3.1-pro-preview",
    "gemini-3-flash-preview",
    "gemini-3.7-flash",
    "gemini-3.8-flash",
    "gemini-4-argon",
]) {
    test(`${modelId} tool continuation preserves API IDs and signatures for duplicate names and restores result order`, async () => {
        const { context, parts } = createContext(modelId);
        await processGeminiStream(
            chunks(
                toolChunk([
                    { functionCall: { id: "server-first", name: "lookup", args: { query: "first" } }, thoughtSignature: "signed-first" },
                    { functionCall: { id: "server-second", name: "lookup", args: { query: "second" } }, thoughtSignature: "signed-second" },
                ]),
                toolChunk([{ functionCall: { id: "server-third", name: "read", args: {} }, thoughtSignature: "signed-third" }]),
            ),
            context,
        );
        const calls = parts.filter((part) => part instanceof ToolCallPart);
        assert.deepEqual(
            calls.map((call) => call.callId),
            [
                "server-first",
                "server-second",
                "server-third",
            ],
        );
        const history = mapHistory(context, [
            { role: 1, content: [new TextPart("Find both values.")] },
            { role: 2, content: calls },
            { role: 1, content: [new ToolResultPart("server-third", [new TextPart("done")])] },
            { role: 1, content: [new ToolResultPart("server-second", [new TextPart('{"value":2}')])] },
            { role: 1, content: [new ToolResultPart("server-first", [new TextPart('{"value":1}')])] },
        ]);
        assert.equal(history.length, 3);
        assert.deepEqual(history[1].parts, [
            { functionCall: { id: "server-first", name: "lookup", args: { query: "first" } }, thoughtSignature: "signed-first" },
            { functionCall: { id: "server-second", name: "lookup", args: { query: "second" } }, thoughtSignature: "signed-second" },
            { functionCall: { id: "server-third", name: "read", args: {} }, thoughtSignature: "signed-third" },
        ]);
        assert.deepEqual(history[2].parts, [
            { functionResponse: { id: "server-first", name: "lookup", response: { value: 1 } } },
            { functionResponse: { id: "server-second", name: "lookup", response: { value: 2 } } },
            { functionResponse: { id: "server-third", name: "read", response: { result: "done" } } },
        ]);
    });

    test(`${modelId} unsigned duplicate-name calls do not inherit another call's inline signature`, async () => {
        const { context, parts } = createContext(modelId);
        await processGeminiStream(
            chunks(
                toolChunk([
                    { functionCall: { id: "signed", name: "lookup", args: { query: "first" } }, thoughtSignature: "first-only" },
                    { functionCall: { id: "unsigned", name: "lookup", args: { query: "second" } } },
                ]),
            ),
            context,
        );
        assert.equal(context.thoughtSignatureCache.get("signed"), "first-only");
        assert.equal(context.thoughtSignatureCache.has("unsigned"), false);
        assert.equal(context.apiToolCallIds.has("unsigned"), true);
        const history = mapHistory(context, [
            { role: 1, content: [new TextPart("Find values.")] },
            { role: 2, content: parts },
        ]);
        assert.equal(history[1].parts[1].thoughtSignature, undefined);
    });

    test(`${modelId} calls without API IDs retain generated IDs internally without adding them to request history`, async () => {
        const { context, parts } = createContext(modelId);
        await processGeminiStream(chunks(toolChunk([{ thought: true, text: "private reasoning", thoughtSignature: "legacy-signed" }]), { functionCalls: [{ name: "lookup", args: { query: "legacy" } }] }), context);
        assert.equal(parts.length, 1);
        const [call] = parts;
        assert.ok(call instanceof ToolCallPart);
        assert.match(call.callId, /^lookup_\d+_/);
        assert.equal(context.apiToolCallIds.size, 0);
        const history = mapHistory(context, [
            { role: 1, content: [new TextPart("Look up a value.")] },
            { role: 2, content: [call] },
            { role: 1, content: [new ToolResultPart(call.callId, [new TextPart("42")])] },
        ]);
        assert.deepEqual(history[1].parts, [{ functionCall: { name: "lookup", args: { query: "legacy" } }, thoughtSignature: "legacy-signed" }]);
        assert.deepEqual(history[2].parts, [{ functionResponse: { name: "lookup", response: { result: "42" } } }]);
    });
}

test("publisher-path models use source ID provenance for matching history call and response IDs", async () => {
    const { context } = createContext("publishers/google/models/gemini-4-argon");
    await processGeminiStream(chunks({ functionCalls: [{ id: "server-call", name: "lookup", args: {} }] }), context);
    const history = mapHistory(context, [
        { role: 1, content: [new TextPart("Look up a value.")] },
        { role: 2, content: [new ToolCallPart("server-call", "lookup", {})] },
        { role: 1, content: [new ToolResultPart("server-call", [new TextPart("42")])] },
    ]);
    assert.equal(history[1].parts[0].functionCall.id, "server-call");
    assert.equal(history[2].parts[0].functionResponse.id, "server-call");
});

test("stream usage includes hidden thinking and carries each omitted token counter independently", async () => {
    const { context, parts } = createContext();
    const usage = await processGeminiStream(
        chunks(
            toolChunk([{ thought: true, text: "private reasoning" }], { promptTokenCount: 100, candidatesTokenCount: 5, thoughtsTokenCount: 40, cachedContentTokenCount: 25 }),
            toolChunk([{ text: "answer" }], { candidatesTokenCount: 8 }),
            toolChunk([], { thoughtsTokenCount: 50 }),
            toolChunk([], { promptTokenCount: 110 }),
        ),
        context,
    );
    assert.deepEqual(usage, { inputTokens: 110, outputTokens: 58, cacheRead: 25 });
    assert.deepEqual(
        parts.map((part) => part.value),
        ["answer"],
    );
    assert.equal(context.charCount.assistant_text, "answer".length);
});

test("cancellation discards buffered tool calls and their signatures", async () => {
    const { context, parts } = createContext();
    const controller = new AbortController();
    context.signal = controller.signal;
    async function* cancelledStream() {
        yield toolChunk([{ functionCall: { id: "cancelled-call", name: "lookup", args: {} }, thoughtSignature: "cancelled-signature" }]);
        controller.abort();
    }
    await assert.rejects(processGeminiStream(cancelledStream(), context), CancellationError);
    assert.deepEqual(parts, []);
    assert.equal(context.thoughtSignatureCache.size, 0);
    assert.equal(context.apiToolCallIds.size, 0);
});

test("mixed source and fallback IDs retain call order without exposing the generated IDs", async () => {
    const { context, parts } = createContext("gemini-3.8-flash");
    await processGeminiStream(
        chunks(
            toolChunk([
                { functionCall: { name: "lookup", args: { query: "fallback" } } },
                { functionCall: { id: "source-id", name: "lookup", args: { query: "source" } }, thoughtSignature: "source-signature" },
            ]),
        ),
        context,
    );
    const [
        fallbackCall,
        sourceCall,
    ] = parts;
    const history = mapHistory(context, [
        { role: 1, content: [new TextPart("Look up both values.")] },
        { role: 2, content: parts },
        { role: 1, content: [new ToolResultPart(sourceCall.callId, [new TextPart('{"value":"source"}')])] },
        { role: 1, content: [new ToolResultPart(fallbackCall.callId, [new TextPart('{"value":"fallback"}')])] },
    ]);
    assert.deepEqual(history[1].parts, [
        { functionCall: { name: "lookup", args: { query: "fallback" } } },
        { functionCall: { id: "source-id", name: "lookup", args: { query: "source" } }, thoughtSignature: "source-signature" },
    ]);
    assert.deepEqual(history[2].parts, [
        { functionResponse: { name: "lookup", response: { value: "fallback" } } },
        { functionResponse: { id: "source-id", name: "lookup", response: { value: "source" } } },
    ]);
});
