import { EffortCatalog, decodeBackend } from "./EffortCatalog";
import { EFFORT_LEVELS, EffortError, EffortPreferenceSnapshot, ResolvedModelRequest, snapshot } from "./EffortTypes";

export function resolveEffort(catalog: EffortCatalog, requestedId: string, preferences?: EffortPreferenceSnapshot): ResolvedModelRequest {
  const identity = catalog.get(requestedId);
  if (!identity) { throw new EffortError("unavailable", `Model not available: ${requestedId}. Refresh Models or select an allowed model.`); }
  const { canonical, alias } = identity;
  const policy = canonical.effort;
  const legacy = decodeBackend(canonical.vendor, canonical.version);
  const preference = alias || !preferences || !Object.hasOwn(preferences.preferences, canonical.id) ? undefined : preferences.preferences[canonical.id];
  if (preference !== undefined && preference !== "catalog-default" && !EFFORT_LEVELS.includes(preference as any)) {
    throw new EffortError("invalid-preference", `Model '${canonical.id}': invalid thinking effort '${String(preference)}'. Choose catalog default or remove the override.`);
  }
  if (!policy && preference !== undefined && preference !== "catalog-default") {
    throw new EffortError("unsupported", `Model '${canonical.id}' does not declare configurable thinking effort in the current catalog.`);
  }
  const value = alias?.effort ?? (preference === undefined || preference === "catalog-default" ? policy?.default : preference);
  if (policy && value !== "provider-default" && !policy.values.includes(value as any)) {
    throw new EffortError("unsupported", `Model '${canonical.id}': effort '${String(value)}' is not permitted by the current catalog. Allowed: ${policy.values.join(", ")}. Choose catalog default or remove the override.`);
  }
  const backend = policy ? canonical.version : legacy.backend;
  const preferenceSource = preferences && Object.hasOwn(preferences.sourceByModel, canonical.id) ? preferences.sourceByModel[canonical.id] : "user";
  return snapshot({ requestedId, canonicalId: canonical.id, backendModelId: canonical.vendor === "grok" && backend === "grok-4.6" ? `xai/${backend}` : backend,
    spec: alias ? { ...canonical, id: alias.id, displayName: alias.displayName, version: alias.version } : canonical,
    ...(policy ? { effort: { kind: policy.kind, value: value!, source: alias ? "legacy-alias"
      : preference === undefined || preference === "catalog-default" ? "catalog-default" : preferenceSource } } : {}),
  } as ResolvedModelRequest);
}
