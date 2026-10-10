const assert = require("node:assert/strict");
const test = require("node:test");
const { ClaudeStreamContentAccumulator, ClaudeThinkingReplayCache, ClaudeThinkingPrefix, claudeEffortConfig } = require("../out/providers/ClaudeThinking.js");

test("maps a catalog effort to Claude request configuration without changing its value", () => {
  assert.deepEqual(claudeEffortConfig("custom-effort"), {
    thinking: { type: "adaptive", display: "omitted" },
    output_config: { effort: "custom-effort" },
  });
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


test("binds replay to tools and context, permanently discarding mismatches", () => {
  const replay = { blocks: [
    { type: "thinking", thinking: "", signature: "signed" },
    { type: "tool_use", id: "tool-1", name: "lookup", input: {} },
  ], toolCallIds: ["tool-1"] };
  const original = new ClaudeThinkingPrefix("claude-sonnet-5-5", [], [{ name: "lookup", input_schema: {} }]);
  original.append({ role: "user", content: [{ type: "text", text: "first" }] });
  const cache = new ClaudeThinkingReplayCache();
  const hash = original.fingerprint(replay.blocks);
  cache.store(replay, hash);
  assert.ok(cache.find(["tool-1"], hash));
  const changed = new ClaudeThinkingPrefix("claude-sonnet-5-5", [], [{ name: "another", input_schema: {} }]);
  changed.append({ role: "user", content: [{ type: "text", text: "first" }] });
  assert.equal(cache.find(["tool-1"], changed.fingerprint(replay.blocks)), undefined);
  assert.equal(cache.find(["tool-1"], hash), undefined);
});

test("cache markers do not invalidate thinking, actual tool inputs do", () => {
  const build = (marked) => {
    const prefix = new ClaudeThinkingPrefix("claude", [{ type: "text", text: "system", ...(marked ? {cache_control: {type: "ephemeral"}} : {}) }]);
    prefix.append({ role: "user", content: [{ type: "tool_result", tool_use_id: "first", content: [{ type: "text", text: "result", ...(marked ? {cache_control: {type: "ephemeral"}} : {}) }] }] });
    return prefix;
  };
  const blocks = [{ type: "tool_use", id: "tool", name: "lookup", input: { cache_control: "actual user data" } }];
  assert.equal(build(true).fingerprint(blocks), build(false).fingerprint(blocks));
  assert.notEqual(build(false).fingerprint(blocks), build(false).fingerprint([{...blocks[0], input: {cache_control: "changed"}}]));
});

test("removing earlier thinking invalidates later cached turns", () => {
  const first = { role: "assistant", content: [{ type: "thinking", thinking: "", signature: "first" }, { type: "tool_use", id: "one", name: "lookup", input: {} }] };
  const oldPrefix = new ClaudeThinkingPrefix("claude");
  oldPrefix.append(first);
  const newPrefix = new ClaudeThinkingPrefix("claude");
  newPrefix.append({...first, content: first.content.slice(1)});
  const second = [{type: "tool_use", id: "two", name: "lookup", input: {}}];
  assert.notEqual(oldPrefix.fingerprint(second), newPrefix.fingerprint(second));
});
