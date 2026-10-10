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
  constructor(public readonly code: "unavailable" | "invalid-preference" | "unsupported" | "invalid-catalog" | "stale", message: string) {
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
