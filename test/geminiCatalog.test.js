const assert = require("node:assert/strict");
const test = require("node:test");

const catalog = require("../src/models.json");

test("bundles the focused Gemini coding catalog", () => {
  const googleModels = catalog.candidateModels.filter((model) => model.vendor === "google");

  assert.deepEqual(googleModels.map((model) => model.id), [
    "gemini-3.8-flash",
    "gemini-3.8-flash-high",
    "gemini-3.7-flash",
    "gemini-3.7-flash-high",
    "gemini-3-flash-preview",
    "gemini-3-flash-preview-high",
    "gemini-3.1-pro-preview",
  ]);

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
  assert.equal(pro.displayName, "Gemini 3.1 Pro (High, Default)");
});
