import type { ModelSpec } from "../providers/VertexModelProvider";
import { EffortError, snapshot } from "./EffortTypes";

/** Validate configuration shape; backend APIs decide which effort levels they support. */
export function validateEffortModel(model: ModelSpec): void {
    const policy = model.effort;
    if (policy === undefined) {
        return;
    }

    const fail = (reason: string): never => {
        throw new EffortError("invalid-catalog", `Model '${model.id}': ${reason}`);
    };
    if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
        fail("effort must be an object.");
    }
    if (!Array.isArray(policy.values) || policy.values.length === 0 || policy.values.some((value) => typeof value !== "string" || !value.trim())) {
        fail("effort values must be a nonempty array of nonempty strings.");
    }
    if (new Set(policy.values).size !== policy.values.length) {
        fail("effort values must be unique.");
    }
    if (typeof policy.default !== "string" || !policy.values.includes(policy.default)) {
        fail("effort default must belong to values.");
    }
}

export class EffortCatalog {
    readonly models: readonly ModelSpec[];
    private readonly byId = new Map<string, ModelSpec>();

    constructor(models: readonly ModelSpec[]) {
        this.models = snapshot(models);
        for (const model of this.models) {
            validateEffortModel(model);
            if (this.byId.has(model.id)) {
                throw new EffortError("invalid-catalog", `Duplicate model ID '${model.id}'.`);
            }
            this.byId.set(model.id, model);
        }
    }

    get(id: string): ModelSpec | undefined {
        return this.byId.get(id);
    }
}

/** Keep readable custom catalogs authoritative, excluding malformed or duplicate definitions. */
export function filterLocalEffortModels(models: ModelSpec[], report: (message: string) => void): ModelSpec[] {
    const invalid = new Set<ModelSpec>();
    const owners = new Map<string, ModelSpec[]>();
    for (const model of models) {
        if (!model || typeof model !== "object") {
            invalid.add(model);
            report("Malformed model definition in custom catalog.");
            continue;
        }
        try {
            validateEffortModel(model);
        } catch (error) {
            invalid.add(model);
            report(String(error));
        }
        const previous = owners.get(model.id) ?? [];
        previous.push(model);
        owners.set(model.id, previous);
    }
    for (const [id, entries] of owners) {
        if (entries.length > 1) {
            entries.forEach((model) => invalid.add(model));
            report(`Duplicate model ID '${id}'.`);
        }
    }
    return models.filter((model) => !invalid.has(model));
}
