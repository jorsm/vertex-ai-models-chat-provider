const assert = require("node:assert/strict");
const test = require("node:test");
const { EffortCatalog, resolveEffort } = require("../out/effort/Effort.js");
const bundled = require("../src/models.json");
const preferences = (id, value, source = "user") => ({ preferences: { [id]: value }, sourceByModel: { [id]: source } });
const catalog = new EffortCatalog(bundled.candidateModels);
// Historical IDs/versions and their expected routes from 6ec5990^:src/models.json.
const legacyAliases = require("./fixtures/legacy-effort-aliases.json");

test("every bundled default is a named choice and the catalog preserves model metadata", () => {
    assert.equal(catalog.models.length, bundled.candidateModels.length);
    for (const model of bundled.candidateModels) {
        assert.deepEqual(catalog.get(model.id), model);
        const request = resolveEffort(catalog, model.id);
        assert.strictEqual(request.spec, catalog.get(model.id));
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
    for (const value of [
        "minimal",
        "invalid",
        "",
        null,
        3,
    ]) {
        assert.throws(() => resolveEffort(catalog, "claude-opus-5-5", preferences("claude-opus-5-5", value)), /effort/);
    }
    // Every bundled model declares effort, so a model without it comes from a custom catalog.
    const plain = { ...bundled.candidateModels[0], id: "plain-model", version: "plain-model", effort: undefined };
    const plainCatalog = new EffortCatalog([plain]);
    assert.throws(() => resolveEffort(plainCatalog, plain.id, preferences(plain.id, "high")), /does not declare/);
    assert.equal(resolveEffort(plainCatalog, plain.id).effort, undefined);
});

test("custom backend names are literal and custom effort strings are catalog choices", () => {
    const custom = {
        ...bundled.candidateModels[0],
        id: "company-model",
        version: "company-reasoner-high",
        effort: {
            values: [
                "ultra",
                "quiet",
            ],
            default: "quiet",
        },
    };
    const index = new EffortCatalog([custom]);
    assert.equal(index.models.length, 1);
    assert.equal(resolveEffort(index, custom.id).spec.version, custom.version);
    assert.equal(resolveEffort(index, custom.id, preferences(custom.id, "ultra")).effort.value, "ultra");
    assert.equal(resolveEffort(new EffortCatalog([{ ...custom, effort: undefined }]), custom.id).spec.version, custom.version);
});

test("historical aliases without effort metadata pin their suffix and preserve catalog identity", () => {
    for (const alias of legacyAliases) {
        const model = { ...bundled.candidateModels.find((m) => m.vendor === alias.vendor && m.version === alias.backend), id: alias.id, version: alias.version, effort: undefined };
        const index = new EffortCatalog([model]);
        const request = resolveEffort(index, model.id, preferences(alias.backend, "invalid"));
        assert.deepEqual(request.effort, { value: alias.effort, source: "legacy-alias" });
        assert.equal(request.spec.version, alias.backend);
        assert.equal(request.spec.id, alias.id);
        assert.deepEqual(request.spec.pricing, model.pricing);
        assert(Object.isFrozen(request.spec));
        assert(Object.isFrozen(request.spec.pricing));
        assert.equal(index.get(model.id).version, alias.version);
        assert.equal(model.version, alias.version);
        assert.throws(() => resolveEffort(index, model.id, preferences(model.id, "high")), /does not declare/);
        assert.throws(() => resolveEffort(catalog, model.id), /Model not available/);
    }
});

test("explicit effort metadata takes precedence over legacy suffixes", () => {
    const model = { ...bundled.candidateModels[0], id: "claude-opus-5-5-max", version: "claude-opus-5-5-max" };
    const index = new EffortCatalog([model]);
    const request = resolveEffort(index, model.id, preferences(model.id, "high"));
    assert.strictEqual(request.spec, index.get(model.id));
    assert.equal(request.spec.version, model.version);
    assert.deepEqual(request.effort, { value: "high", source: "user" });
});

test("legacy decoding is limited to the supported vendor, model family and suffix", () => {
    for (const [
        vendor,
        version,
    ] of [
        [
            "anthropic",
            "company-reasoner-high",
        ],
        [
            "google",
            "gemini-3.8-flash-low",
        ],
        [
            "google",
            "claude-opus-5-5-max",
        ],
        [
            "grok",
            "xai/grok-4.6-xhigh",
        ],
        [
            "grok",
            "xai/company-reasoner-high",
        ],
        [
            "custom",
            "claude-opus-5-5-max",
        ],
        [
            "anthropic",
            "claude-opus-5-5-ultra",
        ],
    ]) {
        const model = { ...bundled.candidateModels[0], id: version, vendor, version, effort: undefined };
        const index = new EffortCatalog([model]);
        const request = resolveEffort(index, model.id);
        assert.strictEqual(request.spec, index.get(model.id));
        assert.equal(request.spec.version, version);
        assert.equal(request.effort, undefined);
    }
});

test("catalog definitions are detached and recursively frozen for requests to reuse", () => {
    const model = structuredClone(bundled.candidateModels[0]);
    const index = new EffortCatalog([model]);
    const request = resolveEffort(index, model.id, preferences(model.id, "high"));
    model.effort.values.splice(0);
    model.pricing.input = 99;
    assert.equal(request.spec.pricing.input, 4);
    assert.deepEqual(request.spec.effort.values, [
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
    ]);
    assert(Object.isFrozen(request.spec.pricing));
    assert(Object.isFrozen(request.spec.effort.values));
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
