import type { ModelSpec } from "../providers/VertexModelProvider";

/** Catalog-owned effort choices for a model; backend APIs determine which levels they support. */
export interface ModelEffortSpec {
    /** Unique, nonempty named levels offered by the picker and mapped by the vendor adapter. */
    values: readonly string[];
    /** Named level sent when no saved preference applies; must be one of `values`. */
    default: string;
}

/** Detached configuration captured before asynchronous work, with Workspace overriding User per model. */
export interface EffortPreferenceSnapshot {
    /** Effective settings by literal model ID; values remain unknown until the selected model is resolved. */
    readonly preferences: Readonly<Record<string, unknown>>;
    /** Scope supplying each saved value; a missing entry is treated as User during resolution. */
    readonly sourceByModel: Readonly<Record<string, "user" | "workspace">>;
}

/** Named effort selected for one request, together with its configuration source. */
export interface ResolvedEffort {
    /** A value from the selected model's catalog choices, before vendor-specific payload mapping. */
    readonly value: string;
    /** `catalog` means no saved preference supplied a value and the named default was selected. */
    readonly source: "user" | "workspace" | "catalog";
}

/** Model configuration and effort decision passed to a provider for one invocation. */
export interface ResolvedModelRequest {
    /** Absent when the model declares no configurable effort, so no effort override is sent. */
    readonly effort?: ResolvedEffort;
    /** Captured backend identity, capabilities and prices retained by the invocation and its retries. */
    readonly spec: ModelSpec;
}

/** An unavailable model, invalid preference, disallowed catalog choice or stale picker selection. */
export class EffortError extends Error {
    /**
     * @param code Failure category for callers that need to refresh choices or report a setting error.
     * @param message Actionable explanation shown by the picker or request error handler.
     */
    constructor(
        public readonly code: "unavailable" | "invalid-preference" | "unsupported" | "stale",
        message: string,
    ) {
        super(message);
        this.name = "EffortError";
    }
}

/**
 * Copies JSON data and recursively freezes it so later edits cannot change a captured decision.
 * Used for catalog metadata, prices and preferences across asynchronous operations and retries.
 *
 * @param value JSON-serializable data; undefined object properties are omitted by serialization.
 * @returns A detached, recursively frozen copy. The generic type is preserved, not made readonly.
 */
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

/** Immutable model index for request resolution and picker snapshots; validation happens at catalog ingestion. */
export class EffortCatalog {
    /** Frozen model definitions in their original catalog order. */
    readonly models: readonly ModelSpec[];
    private readonly byId: Map<string, ModelSpec>;

    /** Copies and indexes already validated models without rechecking catalog structure or API support. */
    constructor(models: readonly ModelSpec[]) {
        this.models = snapshot(models);
        this.byId = new Map(
            this.models.map((model) => [
                model.id,
                model,
            ]),
        );
    }

    /** Returns the frozen definition for an exact catalog ID, or undefined when it is unavailable. */
    get(id: string): ModelSpec | undefined {
        return this.byId.get(id);
    }
}

/**
 * Resolves one model and its saved effort, falling back to the catalog's named default.
 * Only the selected model's preference is checked. Choice membership is enforced here;
 * backend support for that choice remains the API's responsibility.
 *
 * @param catalog Immutable index of the models available for this invocation.
 * @param modelId Exact catalog ID, independent of the backend version sent by the adapter.
 * @param preferences Captured public-request settings; omit for catalog-only internal requests.
 * @returns Detached, frozen model metadata and effort, with effort absent for a model without effort metadata.
 * @throws {EffortError} If the model is unavailable, its preference is malformed, or the choice is not allowed by its catalog.
 */
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
