import { EffortCatalog } from "./EffortCatalog";
import { EffortError, EffortPreferenceSnapshot, ResolvedModelRequest, snapshot } from "./EffortTypes";

export function resolveEffort(catalog: EffortCatalog, modelId: string, preferences?: EffortPreferenceSnapshot): ResolvedModelRequest {
  const spec = catalog.get(modelId);
  if (!spec) {
    throw new EffortError("unavailable", `Model not available: ${modelId}. Refresh Models or select an allowed model.`);
  }
  const preference = preferences && Object.hasOwn(preferences.preferences, modelId)
    ? preferences.preferences[modelId] : undefined;
  if (preference !== undefined && (typeof preference !== "string" || !preference.trim())) {
    throw new EffortError("invalid-preference", `Model '${modelId}': thinking effort must be a nonempty string. Choose a value in the picker.`);
  }
  if (!spec.effort) {
    if (preference !== undefined) {
      throw new EffortError("unsupported", `Model '${modelId}' does not declare configurable thinking effort in the current catalog.`);
    }
    return snapshot({ spec });
  }

  const value = preference === undefined ? spec.effort.default : preference as string;
  if (!spec.effort.values.includes(value)) {
    throw new EffortError("unsupported", `Model '${modelId}': effort '${value}' is not permitted by the current catalog. Allowed: ${spec.effort.values.join(", ")}. Choose a value in the picker.`);
  }
  const source = preference === undefined ? "catalog"
    : preferences?.sourceByModel[modelId] === "workspace" ? "workspace" : "user";
  return snapshot({ spec, effort: { value, source } });
}
