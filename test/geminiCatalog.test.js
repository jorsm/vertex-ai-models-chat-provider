const assert = require("node:assert/strict");
const test = require("node:test");

const catalog = require("../src/models.json");
const { EffortCatalog } = require("../out/effort/Effort.js");

test("bundles the focused Gemini coding catalog", () => {
    const googleModels = new EffortCatalog(catalog.candidateModels).models.filter((model) => model.vendor === "google");

    assert.deepEqual(
        googleModels.map((model) => model.id),
        [
            "gemini-4-argon",
            "gemini-3.8-flash",
            "gemini-3.7-flash",
            "gemini-3-flash-preview",
            "gemini-3.1-pro-preview",
        ],
    );

    const pro = googleModels.find((model) => model.id === "gemini-3.1-pro-preview");
    assert.deepEqual(pro.pricing, {
        input: 2.0,
        output: 12.0,
        cache_read: 0.2,
        cache_create: 0.0,
        longContext: {
            inputThresholdTokens: 200000,
            input: 4.0,
            output: 18.0,
            cache_read: 0.4,
            cache_create: 0.0,
        },
    });
    assert.equal(pro.displayName, "Gemini 3.1 Pro");
});

test("Argon reserves its single-stream thinking and answer budget within the shared context", () => {
    const argon = new EffortCatalog(catalog.candidateModels).get("gemini-4-argon");
    assert.equal(argon.version, "gemini-4-argon");
    assert.equal(argon.displayName, "Gemini 4 Argon");
    assert.equal(argon.maxOutputTokens, 65536);
    assert.equal(argon.maxInputTokens + argon.maxOutputTokens, 1048576);
    assert.deepEqual(argon.capabilities, { imageInput: true, toolCalling: true });
    assert.deepEqual(argon.effort, {
        values: [
            "low",
            "medium",
            "high",
        ],
        default: "medium",
    });
    // Use the current global promotional rates through November 30, 2026.
    assert.deepEqual(argon.pricing, { input: 2, output: 10, cache_read: 0.1, cache_create: 0 });
});
