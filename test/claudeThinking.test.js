const assert = require("node:assert/strict");
const test = require("node:test");
const { ClaudeStreamContentAccumulator, ClaudeThinkingReplayCache, resolveClaudeModelId } = require("../out/providers/ClaudeThinking.js");

test("resolves every supported Claude effort suffix for custom catalogs", () => {
  for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
    assert.deepEqual(resolveClaudeModelId(`claude-custom@20260901-${effort}`), {
      actualId: "claude-custom@20260901",
      effort,
      requestConfig: {
        thinking: { type: "adaptive", display: "omitted" },
        output_config: { effort },
      },
    });
  }

  assert.deepEqual(resolveClaudeModelId("claude-custom-ultra"), { actualId: "claude-custom-ultra" });
});

test("reassembles signed and redacted thinking blocks without exposing them as output", () => {
  const accumulator = new ClaudeStreamContentAccumulator();
  accumulator.start(0, { type: "thinking", thinking: "", signature: "" });
  accumulator.delta(0, { type: "thinking_delta", thinking: "private reasoning" });
  accumulator.delta(0, { type: "signature_delta", signature: "signed-thinking" });
  accumulator.stop(0);
  accumulator.start(1, { type: "redacted_thinking", data: "encrypted-thinking" });
  accumulator.stop(1);
  accumulator.start(2, { type: "text", text: "" });
  accumulator.delta(2, { type: "text_delta", text: "I need a tool." });
  accumulator.stop(2);
  accumulator.start(3, { type: "tool_use", id: "tool-1", name: "lookup", input: {} });
  accumulator.delta(3, { type: "input_json_delta", partial_json: '{"query":"value"}' });
  accumulator.stop(3);

  assert.deepEqual(accumulator.createThinkingReplay(), {
    blocks: [
      { type: "thinking", thinking: "private reasoning", signature: "signed-thinking" },
      { type: "redacted_thinking", data: "encrypted-thinking" },
      { type: "text", text: "I need a tool." },
      { type: "tool_use", id: "tool-1", name: "lookup", input: { query: "value" } },
    ],
    toolCallIds: ["tool-1"],
  });
});

test("creates no replay state when a model emits no thinking blocks", () => {
  const accumulator = new ClaudeStreamContentAccumulator();
  accumulator.start(0, { type: "tool_use", id: "tool-1", name: "lookup", input: {} });
  accumulator.delta(0, { type: "input_json_delta", partial_json: "{}" });
  accumulator.stop(0);

  assert.equal(accumulator.createThinkingReplay(), undefined);
});

test("rejects incomplete signatures and malformed tool input", () => {
  const missingSignature = new ClaudeStreamContentAccumulator();
  missingSignature.start(0, { type: "thinking", thinking: "private", signature: "" });
  missingSignature.stop(0);
  missingSignature.start(1, { type: "tool_use", id: "tool-1", name: "lookup", input: {} });
  missingSignature.stop(1);
  assert.equal(missingSignature.createThinkingReplay(), undefined);

  const malformedInput = new ClaudeStreamContentAccumulator();
  malformedInput.start(0, { type: "thinking", thinking: "private", signature: "signature" });
  malformedInput.stop(0);
  malformedInput.start(1, { type: "tool_use", id: "tool-1", name: "lookup", input: {} });
  malformedInput.delta(1, { type: "input_json_delta", partial_json: "{" });
  malformedInput.stop(1);
  assert.equal(malformedInput.createThinkingReplay(), undefined);
});

test("finds only exact tool-call groups and returns defensive copies", () => {
  const cache = new ClaudeThinkingReplayCache(1);
  cache.store({
    blocks: [
      { type: "thinking", thinking: "private", signature: "signature-1" },
      { type: "tool_use", id: "tool-1", name: "first", input: {} },
      { type: "tool_use", id: "tool-2", name: "second", input: {} },
    ],
    toolCallIds: ["tool-1", "tool-2"],
  });

  assert.equal(cache.find(["tool-1"]), undefined);
  const firstRead = cache.find(["tool-2", "tool-1"]);
  assert.ok(firstRead);
  firstRead[0].signature = "changed";
  assert.equal(cache.find(["tool-1", "tool-2"])[0].signature, "signature-1");

  cache.store({
    blocks: [
      { type: "thinking", thinking: "private", signature: "signature-2" },
      { type: "tool_use", id: "tool-3", name: "third", input: {} },
    ],
    toolCallIds: ["tool-3"],
  });
  assert.equal(cache.find(["tool-1", "tool-2"]), undefined);
});
