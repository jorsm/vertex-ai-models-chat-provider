import Ajv, { type ErrorObject } from "ajv";
import schema from "../schemas/models.schema.json";
import type { ModelCatalog, ModelSpec } from "./providers/VertexModelProvider";

const ajv = new Ajv();
// Validate the envelope separately so local files can retain their valid definitions.
const validateEnvelope = ajv.compile<{ candidateModels: unknown[]; regionPriority: string[] }>({
    ...schema,
    properties: {
        ...schema.properties,
        candidateModels: { ...schema.properties.candidateModels, items: {} },
    },
});
const validateModel = ajv.compile<ModelSpec>({
    $ref: "#/definitions/ModelSpec",
    definitions: schema.definitions,
});

export class ModelCatalogError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ModelCatalogError";
    }
}

function describeError(errors: ErrorObject[] | null | undefined, prefix = ""): string {
    const error = errors?.[0];
    if (!error) {
        return "Invalid model catalog.";
    }
    const path = `${prefix}${error.instancePath}` || "/";
    const detail = error.keyword === "additionalProperties" ? `: '${error.params.additionalProperty}'` : "";
    return `${path} ${error.message}${detail}.`;
}

/** Parse external data once. A reporting callback keeps valid local models; proxies fail as a whole. */
export function parseModelCatalog(value: unknown, reportInvalidModel?: (message: string) => void): ModelCatalog {
    if (!validateEnvelope(value)) {
        throw new ModelCatalogError(describeError(validateEnvelope.errors));
    }
    const report =
        reportInvalidModel ??
        ((message: string) => {
            throw new ModelCatalogError(message);
        });
    const models: ModelSpec[] = [];
    const seenIds = new Set<string>();
    const duplicateIds = new Set<string>();
    for (const [
        index,
        entry,
    ] of value.candidateModels.entries()) {
        if (!validateModel(entry)) {
            report(describeError(validateModel.errors, `/candidateModels/${index}`));
            continue;
        }
        // These relationships are not expressed by the structural JSON schema.
        if (seenIds.has(entry.id)) {
            duplicateIds.add(entry.id);
            report(`Duplicate model ID '${entry.id}': model IDs must be unique.`);
        }
        seenIds.add(entry.id);
        if (entry.effort && !entry.effort.values.includes(entry.effort.default)) {
            report(`Model '${entry.id}': effort default must belong to values.`);
            continue;
        }
        models.push(entry);
    }
    return structuredClone({
        candidateModels: models.filter((model) => !duplicateIds.has(model.id)),
        regionPriority: value.regionPriority,
    });
}
