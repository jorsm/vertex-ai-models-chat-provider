import type { ModelSpec } from "../providers/VertexModelProvider";

export interface ModelEffortSpec {
    values: readonly string[];
    default: string;
}
export interface EffortPreferenceSnapshot {
    readonly preferences: Readonly<Record<string, unknown>>;
    readonly sourceByModel: Readonly<Record<string, "user" | "workspace">>;
}
export interface ResolvedEffort {
    readonly value: string;
    readonly source: "user" | "workspace" | "catalog";
}
export interface ResolvedModelRequest {
    readonly effort?: ResolvedEffort;
    readonly spec: ModelSpec;
}
export class EffortError extends Error {
    constructor(
        public readonly code: "unavailable" | "invalid-preference" | "unsupported" | "stale",
        message: string,
    ) {
        super(message);
        this.name = "EffortError";
    }
}

/** A detached, recursively frozen JSON snapshot, including policy and prices. */
export function snapshot<T>(value: T): T {
    const copy = JSON.parse(JSON.stringify(value));
    const freeze = (item: any): void => {
        if (item && typeof item === "object") {
            Object.values(item).forEach(freeze);
            Object.freeze(item);
        }
    };
    freeze(copy);
    return copy;
}

/** An immutable index over models already validated at catalog ingestion. */
export class EffortCatalog {
    readonly models: readonly ModelSpec[];
    private readonly byId: Map<string, ModelSpec>;

    constructor(models: readonly ModelSpec[]) {
        this.models = snapshot(models);
        this.byId = new Map(
            this.models.map((model) => [
                model.id,
                model,
            ]),
        );
    }

    get(id: string): ModelSpec | undefined {
        return this.byId.get(id);
    }
}

export function resolveEffort(catalog: EffortCatalog, modelId: string, preferences?: EffortPreferenceSnapshot): ResolvedModelRequest {
    const spec = catalog.get(modelId);
    if (!spec) {
        throw new EffortError("unavailable", `Model not available: ${modelId}. Refresh Models or select an allowed model.`);
    }
    const preference = preferences && Object.hasOwn(preferences.preferences, modelId) ? preferences.preferences[modelId] : undefined;
    if (preference !== undefined && (typeof preference !== "string" || !preference.trim())) {
        throw new EffortError("invalid-preference", `Model '${modelId}': thinking effort must be a nonempty string. Choose a value in the picker.`);
    }
    if (!spec.effort) {
        if (preference !== undefined) {
            throw new EffortError("unsupported", `Model '${modelId}' does not declare configurable thinking effort in the current catalog.`);
        }
        return snapshot({ spec });
    }

    const value = preference === undefined ? spec.effort.default : (preference as string);
    if (!spec.effort.values.includes(value)) {
        throw new EffortError("unsupported", `Model '${modelId}': effort '${value}' is not permitted by the current catalog. Allowed: ${spec.effort.values.join(", ")}. Choose a value in the picker.`);
    }
    const source = preference === undefined ? "catalog" : preferences?.sourceByModel[modelId] === "workspace" ? "workspace" : "user";
    return snapshot({ spec, effort: { value, source } });
}
