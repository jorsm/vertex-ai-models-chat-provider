const assert = require("node:assert/strict");
const test = require("node:test");

const catalog = require("../src/models.json");
const { EffortCatalog } = require("../out/effort/Effort.js");

// Catches a Fable 5.2 entry with the wrong backend ID, limits, effort levels or Vertex rate card.
test("claude-fable-5-2 matches its Vertex model card and partner-model pricing", () => {
    const fable = new EffortCatalog(catalog.candidateModels).get("claude-fable-5-2");
    assert.equal(fable.vendor, "anthropic");
    assert.equal(fable.version, "claude-fable-5-2");
    assert.equal(fable.displayName, "Claude Fable 5.2");
    assert.equal(fable.maxInputTokens, 1000000);
    assert.equal(fable.maxOutputTokens, 128000);
    assert.deepEqual(fable.capabilities, { imageInput: true, toolCalling: true });
    assert.deepEqual(fable.effort, {
        values: [
            "low",
            "medium",
            "high",
            "xhigh",
            "max",
        ],
        default: "high",
    });
    // Global rates; Fable 5.2 has no long-context tier.
    assert.deepEqual(fable.pricing, { input: 8, output: 40, cache_read: 0.2, cache_create: 10 });
});
