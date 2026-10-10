import type { ModelSpec } from "../providers/VertexModelProvider";
import { snapshot } from "./EffortTypes";

/** An immutable index over models already validated at catalog ingestion. */
export class EffortCatalog {
    readonly models: readonly ModelSpec[];
    private readonly byId: Map<string, ModelSpec>;

    constructor(models: readonly ModelSpec[]) {
        this.models = snapshot(models);
        this.byId = new Map(this.models.map((model) => [model.id, model]));
    }

    get(id: string): ModelSpec | undefined {
        return this.byId.get(id);
    }
}
