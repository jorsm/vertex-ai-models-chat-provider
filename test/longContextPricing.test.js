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

test('historical usage keeps its recorded prices after catalog changes and new entries append without rewriting',async(t)=>{
 const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'vertex-effort-usage-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const models=require('../src/models.json').candidateModels;
 const tracker=new UsageTrackerService({globalStorageUri:{fsPath:dir}},{getEffectiveCatalog:async()=>({candidateModels:models})});
 const tokens={input:100,output:50,cache_read:0,cache_create:0,characters:{}};
 await tracker.recordUsage('historical-model',tokens,models[0].pricing);
 const filename=(await fs.readdir(path.join(dir,'usage_logs')))[0];
 const logFile=path.join(dir,'usage_logs',filename);const historical=await fs.readFile(logFile,'utf8');
 await tracker.recordUsage('claude-opus-5-5',tokens,models[0].pricing);
 assert((await fs.readFile(logFile,'utf8')).startsWith(historical));
 const entries=await tracker.getUsageForDate(filename.slice(0,-6));
 assert.equal(entries.length,2);assert.equal(entries[1].model,'claude-opus-5-5');
 assert.equal(entries[0].cost,entries[1].cost);
 assert.deepEqual(Object.keys(entries[1]).sort(),['cost','model','timestamp','tokens']);
});
