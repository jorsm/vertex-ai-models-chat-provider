const assert = require("node:assert/strict");
const Module = require("node:module");
const test = require("node:test");

const originalLoad = Module._load;
let UsageTrackerService;
try {
  Module._load = function (request, parent, isMain) {
    if (request === "vscode") {
      return {
        EventEmitter: class { fire() {} },
        window: { createOutputChannel: () => ({ appendLine() {} }) },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  ({ UsageTrackerService } = require("../out/UsageTrackerService.js"));
} finally {
  Module._load = originalLoad;
}

function trackerFor(pricing) {
  const catalogResolver = { getEffectiveCatalog: async () => ({ candidateModels: [{ id: "tiered", pricing }] }) };
  return new UsageTrackerService({ globalStorageUri: { fsPath: "/tmp" } }, catalogResolver);
}

test("uses long-context prices for the complete input context", async () => {
  const tracker = trackerFor({
    input: 2,
    output: 12,
    cache_read: 0.2,
    longContext: { inputThresholdTokens: 200000, input: 4, output: 18, cache_read: 0.4 },
  });

  const atThreshold = await tracker.calculateCost("tiered", {
    input: 190000, output: 10000, cache_read: 10000, cache_create: 0, characters: {},
  });
  const aboveThreshold = await tracker.calculateCost("tiered", {
    input: 190000, output: 10000, cache_read: 10001, cache_create: 0, characters: {},
  });

  assert.equal(atThreshold, 0.502);
  assert.equal(aboveThreshold, 0.9440004);
});

test("keeps the flat rate for models without a long-context price", async () => {
  const tracker = trackerFor({ input: 1, output: 2, cache_read: 0.1, cache_create: 3 });
  const cost = await tracker.calculateCost("tiered", {
    input: 250000, output: 10000, cache_read: 50000, cache_create: 1000, characters: {},
  });
  assert.equal(cost, 0.278);
});
