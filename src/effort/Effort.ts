import type { ModelSpec } from "../providers/VertexModelProvider";

/** Catalog-owned effort choices for a model; backend APIs determine which levels they support. */
export interface ModelEffortSpec {
    /** Unique, nonempty named levels offered by the picker and mapped by the vendor adapter. */
    values: readonly string[];
    /** Named level sent when no saved preference applies; must be one of `values`. */
    default: string;
}

/** Scopes that can supply a saved thinking-effort preference. */
export type EffortPreferenceSource = "user" | "workspace";

/**
 * Preference maps copied before asynchronous work.
 *
 * @remarks
 * Workspace overrides User per model. Invalid values remain in the snapshot so
 * {@link resolveEffort} can report them rather than silently use a lower scope.
 */
export interface EffortPreferenceSnapshot {
    /** Effective settings by literal model ID; values remain unknown until the selected model is resolved. */
    readonly preferences: Readonly<Record<string, unknown>>;
    /** Scope supplying each saved value; a missing entry is treated as User during resolution. */
    readonly sourceByModel: Readonly<Record<string, EffortPreferenceSource>>;
}

/** Named effort selected for one request, together with its configuration source. */
export interface ResolvedEffort {
    /** A value from the selected model's catalog choices, before vendor-specific payload mapping. */
    readonly value: string;
    /** `catalog` means no saved preference supplied a value and the named default was selected. */
    readonly source: EffortPreferenceSource | "catalog";
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
     * @param code - Failure category used to refresh choices or report a setting error.
     * @param message - Actionable explanation shown by the picker or request error handler.
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
 * Immutable model index shared by request resolution and picker sessions.
 *
 * @remarks
 * Catalog ingestion validates model structure and effort metadata. This index
 * copies and freezes definitions once; requests and picker snapshots reuse them.
 * It preserves catalog order and uses literal IDs without backend aliases.
 */
export class EffortCatalog {
    private readonly byId: Map<string, ModelSpec>;

    /** Frozen model definitions in their original catalog order. */
    public readonly models: readonly ModelSpec[];

    /**
     * Copies and indexes already validated models.
     *
     * @param models - Catalog entries to detach and freeze before indexing.
     */
    constructor(models: readonly ModelSpec[]) {
        const copy = structuredClone(models);
        freezeCatalog(copy);
        this.models = copy;
        this.byId = new Map(
            this.models.map((model) => [
                model.id,
                model,
            ]),
        );
    }

    /**
     * Finds a model by its exact catalog ID.
     *
     * @param id - Literal catalog ID, independent of the backend version.
     * @returns The frozen definition, or `undefined` if it is unavailable.
     */
    public get(id: string): ModelSpec | undefined {
        return this.byId.get(id);
    }
}

/**
 * Resolves one model and its saved effort, using the catalog default when no value is saved.
 *
 * @remarks
 * Only the selected model's preference is checked. Choice membership is enforced here;
 * backend support for that choice remains the API's responsibility.
 *
 * @param catalog - Immutable index of the models available for this invocation.
 * @param modelId - Exact catalog ID, independent of the backend version sent by the adapter.
 * @param preferences - Captured public-request settings; omit for catalog-only internal requests.
 * @returns The catalog's frozen model definition and a captured effort decision,
 * with effort absent for a model without effort metadata.
 * @throws An {@link EffortError} if the model is unavailable, its preference is
 * malformed, or the choice is not allowed by its catalog.
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
        return { spec };
    }

    let value = spec.effort.default;
    let source: ResolvedEffort["source"] = "catalog";
    if (typeof preference === "string") {
        value = preference;
        source = preferences?.sourceByModel[modelId] === "workspace" ? "workspace" : "user";
    }
    if (!spec.effort.values.includes(value)) {
        throw new EffortError("unsupported", `Model '${modelId}': effort '${value}' is not permitted by the current catalog. Allowed: ${spec.effort.values.join(", ")}. Choose a value in the picker.`);
    }
    return { spec, effort: { value, source } };
}

/** Guards catalog definitions against accidental writes after indexing. */
function freezeCatalog(value: unknown): void {
    if (typeof value !== "object" || value === null) {
        return;
    }
    for (const child of Object.values(value)) {
        freezeCatalog(child);
    }
    Object.freeze(value);
}
