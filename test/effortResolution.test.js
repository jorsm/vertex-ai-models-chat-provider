const assert = require('node:assert/strict');
const test = require('node:test');
const { EffortCatalog, filterLocalEffortModels } = require('../out/effort/EffortCatalog.js');
const { resolveEffort } = require('../out/effort/ResolveEffort.js');
const original = require('./fixtures/thinking-effort-original-catalog.json');
const bundled = require('../src/models.json');
const preferences = (id, value, source = 'user') => ({ preferences: { [id]: value }, sourceByModel: { [id]: source } });
const catalog = new EffortCatalog(bundled.candidateModels);
const withAlias = () => ({...structuredClone(bundled.candidateModels[0]),legacyEffortAliases:[
  {id:'claude-opus-5-5-high',displayName:'Claude Opus 5.5 (High)',version:'claude-opus-5-5-high',effort:'high'},
]});

test('bundled selectors contain only regular models with independent effort and preserve model metadata', () => {
  assert.equal(catalog.models.length, 15);
  assert.equal(catalog.project().length, 15);
  assert(bundled.candidateModels.every(m=>m.legacyEffortAliases===undefined));
  for (const model of original.candidateModels) {
    const projected = catalog.project().find(m => m.id === model.id);
    if (!projected) { assert.throws(()=>resolveEffort(catalog,model.id),/Model not available/);continue; }
    for (const key of ['id','displayName','version','vendor','family','maxInputTokens','maxOutputTokens','capabilities','pricing']) {
      assert.deepEqual(projected[key], model[key], `${model.id}: ${key}`);
    }
    const resolved = resolveEffort(catalog, model.id);
    const match = model.version.match(/-(low|medium|high|xhigh|max)$/);
    assert.equal(resolved.backendModelId, match ? model.version.slice(0, -match[0].length) : model.version);
    if (resolved.effort) assert.equal(resolved.effort.value, match?.[1] ?? 'provider-default');
  }
  assert.equal(resolveEffort(catalog, 'claude-sonnet-5-5').effort.value, 'high');
  assert.equal(resolveEffort(catalog, 'claude-haiku-5-5').effort.value, 'medium');
});

test('canonical public preferences, internal defaults and explicit catalog defaults are distinct', () => {
  const id = 'claude-opus-5-5';
  assert.equal(resolveEffort(catalog, id).effort.value, 'provider-default');
  assert.deepEqual(resolveEffort(catalog, id, preferences(id, 'max', 'workspace')).effort,
    {kind:'anthropic-adaptive', value:'max', source:'workspace'});
  assert.equal(resolveEffort(catalog, id, preferences(id, 'catalog-default')).effort.value, 'provider-default');
  assert.throws(()=>resolveEffort(catalog, `${id}-high`, preferences(id, 'max')), /Model not available/);
  assert.throws(() => resolveEffort(catalog, 'missing'), /Model not available/);
});

test('only the requested preference is validated; missing metadata never grants effort', () => {
  assert.equal(resolveEffort(catalog, 'claude-opus-5-5', preferences('unrelated','invalid')).effort.value, 'provider-default');
  for (const value of ['low', 'invalid', null, 3]) assert.throws(() => resolveEffort(catalog, 'claude-opus-5-5', preferences('claude-opus-5-5', value)), /effort/);
  assert.throws(() => resolveEffort(catalog, 'claude-haiku-4-5', preferences('claude-haiku-4-5','high')), /does not declare/);
  assert.equal(resolveEffort(catalog, 'claude-haiku-4-5', preferences('claude-haiku-4-5','catalog-default')).effort, undefined);
  const old = new EffortCatalog(original.candidateModels);
  assert.equal(resolveEffort(old, 'claude-opus-5-5-high').backendModelId, 'claude-opus-5-5');
  assert.equal(resolveEffort(old, 'claude-opus-5-5-high').effort, undefined);
  assert(old.project().length < original.candidateModels.length);
  assert(old.project().every(m=>!/-((?:low|medium|high|xhigh|max))$/.test(m.version)));
});

test('catalog and resolved requests are detached recursively frozen snapshots', () => {
  const model = structuredClone(bundled.candidateModels[0]);
  const index = new EffortCatalog([model]);
  const request = resolveEffort(index, model.id, preferences(model.id, 'high'));
  model.effort.values.splice(0); model.pricing.input = 99;
  assert.equal(request.spec.pricing.input, 4);
  assert.deepEqual(request.spec.effort.values, ['high', 'max']);
  assert(Object.isFrozen(request.spec.pricing));
  assert(Object.isFrozen(request.spec.effort.values));
});

for (const [name, mutate] of [
  ['empty values', m => m.effort.values = []],
  ['duplicate values', m => m.effort.values = ['high','high']],
  ['unknown value', m => m.effort.values = ['ultra']],
  ['default outside policy', m => m.effort.default = 'low'],
  ['unknown kind', m => m.effort.kind = 'unknown'],
  ['wrong vendor', m => m.vendor = 'google'],
  ['suffixed canonical version', m => m.version += '-high'],
  ['alias redirect', m => m.legacyEffortAliases[0].version = 'claude-opus-5-high'],
  ['alias mismatch', m => m.legacyEffortAliases[0].effort = 'max'],
  ['alias collision', m => m.legacyEffortAliases[0].id = m.id],
  ['null policy', m => m.effort = null],
  ['aliases without policy', m => delete m.effort],
  ['older incompatible Claude', m => m.version = 'claude-haiku-4-5'],
]) test(`rejects ${name} and quarantines local definitions without bundled fallback`, () => {
  const bad = withAlias(); mutate(bad);
  assert.throws(() => new EffortCatalog([bad]), /Model|Duplicate/);
  const errors = [];
  const good = bundled.candidateModels.at(-1);
  assert.deepEqual(filterLocalEffortModels([bad,good], e => errors.push(e)), [good]);
  assert(errors.length);
});

test('collisions quarantine both definitions, including chained or ambiguous aliases', () => {
  const a = withAlias();
  const b = {...structuredClone(a), id:a.legacyEffortAliases[0].id, legacyEffortAliases:[]};
  assert.throws(() => new EffortCatalog([a,b]), /Duplicate/);
  assert.deepEqual(filterLocalEffortModels([a,b], () => {}), []);
});

test('route validation rejects Gemini token budgets, minimal Flash and unsupported Grok transport', () => {
  const gemini = bundled.candidateModels.find(m=>m.id==='gemini-3.8-flash');
  assert.throws(()=>new EffortCatalog([{...gemini,version:'gemini-2.5-pro'}]), /token-budget/);
  assert.throws(()=>new EffortCatalog([{...gemini,effort:{...gemini.effort,values:['minimal','high']}}]), /Minimal/);
  const grok = bundled.candidateModels.at(-1);
  assert.throws(()=>new EffortCatalog([grok], 'proxy'), /direct Vertex/);
  assert.throws(()=>new EffortCatalog([{...grok,effort:{...grok.effort,values:['xhigh']}}]), /supported/);
});

test('a reused ID with a changed restrictive policy revalidates saved choices', () => {
  const model = structuredClone(bundled.candidateModels[0]);
  model.effort.values = ['high']; model.legacyEffortAliases = [];
  assert.throws(()=>resolveEffort(new EffortCatalog([model]), model.id, preferences(model.id,'max')), /not permitted/);
});

test('prototype-named canonical IDs have no inherited preference or source',()=>{
 const model={...bundled.candidateModels[0],id:'constructor',legacyEffortAliases:[]};const index=new EffortCatalog([model]);
 assert.equal(resolveEffort(index,'constructor',{preferences:{},sourceByModel:{}}).effort.value,'provider-default');
 assert.equal(resolveEffort(index,'constructor',{preferences:{constructor:'high'},sourceByModel:{}}).effort.source,'user');
});
