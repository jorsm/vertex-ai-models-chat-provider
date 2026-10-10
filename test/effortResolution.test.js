const assert = require("node:assert/strict");
const test = require("node:test");
const { EffortCatalog, filterLocalEffortModels } = require("../out/effort/EffortCatalog.js");
const { resolveEffort } = require("../out/effort/ResolveEffort.js");
const bundled = require("../src/models.json");
const preferences = (id, value, source = "user") => ({ preferences: { [id]: value }, sourceByModel: { [id]: source } });
const catalog = new EffortCatalog(bundled.candidateModels);

test("every bundled default is a named choice and the catalog preserves model metadata", () => {
    assert.equal(catalog.models.length, 15);
    for (const model of bundled.candidateModels) {
        assert.deepEqual(catalog.get(model.id), model);
        const request = resolveEffort(catalog, model.id);
        assert.deepEqual(request.spec, model);
        if (model.effort) {
            assert(model.effort.values.includes(model.effort.default));
            assert.deepEqual(request.effort, { value: model.effort.default, source: "catalog" });
        } else {
            assert.equal(request.effort, undefined);
        }
    }
});

test("named public preferences and catalog-only internal defaults remain distinct", () => {
    const id = "claude-opus-5-5";
    assert.equal(resolveEffort(catalog, id).effort.value, "medium");
    assert.deepEqual(resolveEffort(catalog, id, preferences(id, "max", "workspace")).effort, { value: "max", source: "workspace" });
    assert.equal(resolveEffort(catalog, id, preferences(id, "medium")).effort.value, "medium");
    assert.throws(() => resolveEffort(catalog, "missing"), /Model not available/);
});

test("only the selected preference is checked; models without effort have no fabricated controls", () => {
    assert.equal(resolveEffort(catalog, "claude-opus-5-5", preferences("unrelated", "invalid")).effort.value, "medium");
    for (const value of ["low", "invalid", "", null, 3]) {
        assert.throws(() => resolveEffort(catalog, "claude-opus-5-5", preferences("claude-opus-5-5", value)), /effort/);
    }
    assert.throws(() => resolveEffort(catalog, "claude-haiku-4-5", preferences("claude-haiku-4-5", "high")), /does not declare/);
    assert.equal(resolveEffort(catalog, "claude-haiku-4-5").effort, undefined);
});

test("custom backend names are literal and custom effort strings are catalog choices", () => {
    const custom = { ...bundled.candidateModels[0], id: "company-model", version: "company-reasoner-high", effort: { values: ["ultra", "quiet"], default: "quiet" } };
    const index = new EffortCatalog([custom]);
    assert.equal(index.models.length, 1);
    assert.equal(resolveEffort(index, custom.id).spec.version, custom.version);
    assert.equal(resolveEffort(index, custom.id, preferences(custom.id, "ultra")).effort.value, "ultra");
    assert.equal(resolveEffort(new EffortCatalog([{ ...custom, effort: undefined }]), custom.id).spec.version, custom.version);
});

test("catalog and resolved requests are detached recursively frozen snapshots", () => {
    const model = structuredClone(bundled.candidateModels[0]);
    const index = new EffortCatalog([model]);
    const request = resolveEffort(index, model.id, preferences(model.id, "high"));
    model.effort.values.splice(0);
    model.pricing.input = 99;
    assert.equal(request.spec.pricing.input, 4);
    assert.deepEqual(request.spec.effort.values, ["medium", "high", "max"]);
    assert(Object.isFrozen(request.spec.pricing));
    assert(Object.isFrozen(request.spec.effort.values));
});

for (const [name, mutate] of [
    ["empty values", (m) => (m.effort.values = [])],
    ["duplicate values", (m) => (m.effort.values = ["high", "high"])],
    ["empty value", (m) => (m.effort.values = [""])],
    ["non-string value", (m) => (m.effort.values = [3])],
    ["default outside choices", (m) => (m.effort.default = "low")],
    ["missing default", (m) => delete m.effort.default],
    ["null policy", (m) => (m.effort = null)],
]) {
    test(`malformed ${name} excludes only its definition without bundled fallback`, () => {
        const bad = structuredClone(bundled.candidateModels[0]);
        mutate(bad);
        assert.throws(() => new EffortCatalog([bad]), /Model/);
        const errors = [];
        const good = bundled.candidateModels.at(-1);
        assert.deepEqual(
            filterLocalEffortModels([bad, good], (error) => errors.push(error)),
            [good],
        );
        assert(errors.length);
    });
}

test("duplicate model IDs exclude both definitions", () => {
    const a = structuredClone(bundled.candidateModels[0]);
    const b = { ...a, version: "different-backend" };
    assert.throws(() => new EffortCatalog([a, b]), /Duplicate/);
    assert.deepEqual(
        filterLocalEffortModels([a, b], () => {}),
        [],
    );
});

test("a reused ID with changed choices revalidates saved preferences", () => {
    const model = structuredClone(bundled.candidateModels[0]);
    model.effort = { values: ["high"], default: "high" };
    assert.throws(() => resolveEffort(new EffortCatalog([model]), model.id, preferences(model.id, "max")), /not permitted/);
});

test("prototype-named model IDs have no inherited preference or source", () => {
    const model = { ...bundled.candidateModels[0], id: "constructor" };
    const index = new EffortCatalog([model]);
    assert.equal(resolveEffort(index, "constructor", { preferences: {}, sourceByModel: {} }).effort.value, "medium");
    assert.equal(resolveEffort(index, "constructor", { preferences: { constructor: "high" }, sourceByModel: {} }).effort.source, "user");
});
