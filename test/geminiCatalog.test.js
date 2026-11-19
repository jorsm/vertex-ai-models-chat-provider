const assert = require("node:assert/strict");
const test = require("node:test");

const catalog = require("../src/models.json");
const { EffortCatalog } = require("../out/effort/Effort.js");

test("bundles the focused Gemini coding catalog", () => {
    const googleModels = new EffortCatalog(catalog.candidateModels).models.filter((model) => model.vendor === "google");

    assert.deepEqual(
        googleModels.map((model) => model.id),
        [
            "gemini-4-neon",
            "gemini-4-hydrogen",
            "gemini-4-carbon",
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

for (const [
    id,
    displayName,
] of [
    [
        "gemini-4-neon",
        "Gemini 4 Neon",
    ],
    [
        "gemini-4-hydrogen",
        "Gemini 4 Hydrogen",
    ],
    [
        "gemini-4-carbon",
        "Gemini 4 Carbon",
    ],
    [
        "gemini-4-argon",
        "Gemini 4 Argon",
    ],
]) {
    // Catches a Gemini 4 entry that advertises the 1M-token continuation output we don't support,
    // or overlaps input and output in the shared 1,048,576-token context.
    test(`${id} reserves its single-stream thinking and answer budget within the shared context`, () => {
        const model = new EffortCatalog(catalog.candidateModels).get(id);
        assert.equal(model.version, id);
        assert.equal(model.displayName, displayName);
        assert.equal(model.maxOutputTokens, 65536);
        assert.equal(model.maxInputTokens + model.maxOutputTokens, 1048576);
        assert.deepEqual(model.capabilities, { imageInput: true, toolCalling: true });
        assert.equal(model.effort.default, id === "gemini-4-neon" || id === "gemini-4-hydrogen" ? "high" : "medium");
        assert.ok(model.effort.values.includes(model.effort.default));
    });
}

for (const [
    id,
    pricing,
    effortValues,
] of [
    [
        "gemini-4-neon",
        { input: 3, output: 15, cache_read: 0.15, cache_create: 0 },
        [
            "low",
            "medium",
            "high",
            "xhigh",
        ],
    ],
    [
        "gemini-4-hydrogen",
        { input: 1.5, output: 7.5, cache_read: 0.075, cache_create: 0 },
        [
            "low",
            "medium",
            "high",
            "xhigh",
        ],
    ],
    [
        "gemini-4-carbon",
        { input: 2, output: 10, cache_read: 0.1, cache_create: 0 },
        [
            "low",
            "medium",
            "high",
        ],
    ],
    [
        "gemini-4-argon",
        { input: 2, output: 10, cache_read: 0.1, cache_create: 0 },
        [
            "low",
            "medium",
            "high",
        ],
    ],
]) {
    // Catches a Gemini 4 entry offering a thinking level the model rejects (xhigh on Carbon/Argon) or omitting one it supports, or stale prices.
    test(`${id} offers its documented thinking levels and standard global prices`, () => {
        const model = new EffortCatalog(catalog.candidateModels).get(id);
        assert.deepEqual(model.effort.values, effortValues);
        assert.deepEqual(model.pricing, pricing);
    });
}
