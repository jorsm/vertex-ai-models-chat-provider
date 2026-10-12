const assert = require("node:assert/strict");
const test = require("node:test");
const Ajv = require("ajv");
const { parseModelCatalog, ModelCatalogError } = require("../out/ModelCatalogParser.js");
const schema = require("../schemas/models.schema.json");
const bundled = require("../src/models.json");
const model = bundled.candidateModels[0];
const catalog = (models = [model]) => ({ candidateModels: models, regionPriority: ["global"] });

test("the bundled catalog passes the complete JSON schema and catalog relationships", () => {
    const validate = new Ajv().compile(schema);
    assert(validate(bundled), JSON.stringify(validate.errors));
    assert.deepEqual(parseModelCatalog(bundled), bundled);
});

test("custom vendors, literal backends and effort levels are accepted without capability checks", () => {
    const custom = {
        ...model,
        id: "company-model",
        vendor: "future-provider",
        version: "organization/reasoner-high",
        effort: {
            values: [
                "quiet",
                "ultra",
            ],
            default: "quiet",
        },
    };
    assert.deepEqual(parseModelCatalog(catalog([custom])), catalog([custom]));
});

test("parsed catalogs are detached from the input, without coercing or mutating it", () => {
    const source = structuredClone(catalog());
    const parsed = parseModelCatalog(source);
    parsed.candidateModels[0].effort.values.push("custom");
    parsed.regionPriority.push("us-east5");
    assert.deepEqual(source, catalog());
    const invalid = structuredClone(catalog());
    invalid.candidateModels[0].maxOutputTokens = "100";
    assert.throws(() => parseModelCatalog(invalid), /maxOutputTokens/);
    assert.equal(invalid.candidateModels[0].maxOutputTokens, "100");
});

for (const [
    name,
    mutate,
    field,
] of [
    [
        "empty effort values",
        (m) => (m.effort.values = []),
        "effort/values",
    ],
    [
        "duplicate effort values",
        (m) =>
            (m.effort.values = [
                "high",
                "high",
            ]),
        "effort/values",
    ],
    [
        "empty effort value",
        (m) => (m.effort.values = [""]),
        "effort/values/0",
    ],
    [
        "blank effort value",
        (m) => (m.effort.values = [" "]),
        "effort/values/0",
    ],
    [
        "non-string effort value",
        (m) => (m.effort.values = [3]),
        "effort/values/0",
    ],
    [
        "effort values as a string",
        (m) => (m.effort.values = "high"),
        "effort/values",
    ],
    [
        "default outside choices",
        (m) => (m.effort.default = "unsupported"),
        "default must belong",
    ],
    [
        "missing default",
        (m) => delete m.effort.default,
        "default",
    ],
    [
        "missing values",
        (m) => delete m.effort.values,
        "values",
    ],
    [
        "null effort",
        (m) => (m.effort = null),
        "effort",
    ],
    [
        "array effort",
        (m) => (m.effort = []),
        "effort",
    ],
    [
        "missing pricing",
        (m) => delete m.pricing,
        "pricing",
    ],
    [
        "invalid price",
        (m) => (m.pricing.input = -1),
        "pricing/input",
    ],
    [
        "infinite price",
        (m) => (m.pricing.input = Infinity),
        "pricing/input",
    ],
    [
        "missing capability",
        (m) => delete m.capabilities.imageInput,
        "imageInput",
    ],
    [
        "invalid token limit",
        (m) => (m.maxOutputTokens = 0),
        "maxOutputTokens",
    ],
    [
        "unsafe token limit",
        (m) => (m.maxOutputTokens = Number.MAX_SAFE_INTEGER + 1),
        "maxOutputTokens",
    ],
    [
        "unknown model field",
        (m) => (m.unexpected = true),
        "unexpected",
    ],
]) {
    test(`${name} fails strict ingestion and excludes only that local definition`, () => {
        const bad = structuredClone(model);
        mutate(bad);
        const good = bundled.candidateModels.at(-1);
        assert.throws(
            () =>
                parseModelCatalog(
                    catalog([
                        bad,
                        good,
                    ]),
                ),
            (error) => error instanceof ModelCatalogError && error.message.includes(field),
        );
        const errors = [];
        assert.deepEqual(
            parseModelCatalog(
                catalog([
                    bad,
                    good,
                ]),
                (message) => errors.push(message),
            ),
            catalog([good]),
        );
        assert.equal(errors.length, 1);
        assert(errors[0].includes(field), errors[0]);
    });
}

test("duplicate IDs fail strict ingestion and exclude every ambiguous local definition", () => {
    const duplicate = { ...model, version: "different-backend" };
    const good = bundled.candidateModels.at(-1);
    assert.throws(
        () =>
            parseModelCatalog(
                catalog([
                    model,
                    duplicate,
                ]),
            ),
        /Duplicate model ID/,
    );
    const errors = [];
    assert.deepEqual(
        parseModelCatalog(
            catalog([
                model,
                duplicate,
                good,
            ]),
            (message) => errors.push(message),
        ),
        catalog([good]),
    );
    assert.equal(errors.length, 1);
    duplicate.effort = { values: ["high"], default: "outside" };
    assert.deepEqual(
        parseModelCatalog(
            catalog([
                model,
                duplicate,
                good,
            ]),
            () => {},
        ),
        catalog([good]),
    );
});

test("an empty local result stays authoritative and a valid empty catalog needs no regions", () => {
    const bad = { ...model, effort: null };
    assert.deepEqual(
        parseModelCatalog(catalog([bad]), () => {}),
        catalog([]),
    );
    assert.deepEqual(parseModelCatalog({ candidateModels: [], regionPriority: [] }), { candidateModels: [], regionPriority: [] });
});

test("invalid envelopes fail even when local model errors can be reported", () => {
    for (const value of [
        null,
        [],
        {},
        { candidateModels: "models", regionPriority: ["global"] },
        { candidateModels: [], regionPriority: "global" },
        { candidateModels: [], regionPriority: [42] },
        { candidateModels: [], regionPriority: ["https://elsewhere"] },
        { candidateModels: [model], regionPriority: [] },
        { ...catalog(), unexpected: true },
    ]) {
        assert.throws(() => parseModelCatalog(value, () => {}), ModelCatalogError);
    }
});
