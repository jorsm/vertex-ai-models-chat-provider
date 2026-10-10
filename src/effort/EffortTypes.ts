import type { ModelSpec } from "../providers/VertexModelProvider";

export const EFFORT_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = typeof EFFORT_LEVELS[number];
export type EffortPreference = EffortLevel | "catalog-default";
export interface ModelEffortSpec {
  kind: "anthropic-adaptive" | "gemini-thinking-level" | "grok-reasoning-effort";
  values: readonly EffortLevel[];
  default: EffortLevel | "provider-default";
}
export interface LegacyEffortAlias {
  id: string;
  displayName: string;
  version: string;
  effort: EffortLevel;
}
export interface EffortPreferenceSnapshot {
  readonly preferences: Readonly<Record<string, unknown>>;
  readonly sourceByModel: Readonly<Record<string, "user" | "workspace">>;
}
export interface ResolvedEffort {
  readonly kind: ModelEffortSpec["kind"];
  readonly value: EffortLevel | "provider-default";
  readonly source: "user" | "workspace" | "catalog-default" | "legacy-alias";
}
export interface ResolvedModelRequest {
  readonly requestedId: string;
  readonly canonicalId: string;
  readonly backendModelId: string;
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
