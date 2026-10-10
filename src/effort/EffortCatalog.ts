import type { ModelSpec } from "../providers/VertexModelProvider";
import { EffortError, EffortLevel, LegacyEffortAlias, ModelEffortSpec, snapshot } from "./EffortTypes";

const MODES: Record<ModelEffortSpec["kind"], { vendor: string; values: readonly EffortLevel[] }> = {
  "anthropic-adaptive": { vendor: "anthropic", values: ["low", "medium", "high", "xhigh", "max"] },
  "gemini-thinking-level": { vendor: "google", values: ["minimal", "low", "medium", "high"] },
  "grok-reasoning-effort": { vendor: "grok", values: ["low", "medium", "high"] },
};

/** Legacy decoders only; metadata never synthesizes an alias from a suffix. */
export function decodeBackend(vendor: string, version: string): { backend: string; effort?: EffortLevel } {
  const pattern = vendor === "anthropic" ? /-(low|medium|high|xhigh|max)$/
    : vendor === "google" ? /-(high)$/ : vendor === "grok" ? /-(low|medium|high)$/ : undefined;
  const match = pattern?.exec(version);
  return { backend: match ? version.slice(0, -match[0].length) : version,
    ...(match ? { effort: match[1] as EffortLevel } : {}) };
}

export function validateEffortModel(model: ModelSpec, transport: "direct" | "proxy" = "direct"): void {
  const fail = (reason: string): never => { throw new EffortError("invalid-catalog", `Model '${model.id}': ${reason}`); };
  const policy = model.effort;
  if (!policy) {
    if (policy !== undefined || model.legacyEffortAliases !== undefined) { fail("aliases require a valid effort policy."); }
    return;
  }
  const mode = MODES[policy.kind];
  if (!mode || mode.vendor !== model.vendor) { fail("effort kind does not match a supported adapter/vendor."); }
  if (typeof model.version !== "string" || decodeBackend(model.vendor, model.version).effort) {
    fail("a configurable canonical version must not contain an explicit effort suffix.");
  }
  const version = model.version;
  if (policy.kind === "gemini-thinking-level" && !/^gemini-3(?:[.-]|$)/.test(version)) {
    fail("thinkingLevel requires a Gemini 3 family model; token-budget models are incompatible.");
  }
  if (policy.kind === "anthropic-adaptive" && (!/^claude-/.test(version) || /(?:^|-)3(?:[.-]|$)|claude-haiku-4|claude-sonnet-4-[05]|claude-opus-4(?:@|$)|claude-opus-4-[15](?:@|$)/.test(version))) {
    fail("this Claude family does not support adaptive effort.");
  }
  if (policy.kind === "grok-reasoning-effort" && (transport === "proxy" || !/^(?:xai\/)?grok-4\.6$/.test(version))) {
    fail("Grok effort requires the supported direct Vertex Grok 4.6 route.");
  }
  if (!Array.isArray(policy.values) || !policy.values.length || new Set(policy.values).size !== policy.values.length
    || policy.values.some((value) => !mode.values.includes(value))) { fail("effort values must be nonempty, unique and supported by the adapter."); }
  if (/^gemini-3\.[78]-flash/.test(version) && policy.values.includes("minimal")) { fail("Minimal is not supported by this Gemini Flash route."); }
  if (/^gemini-3(?:\.[0-9]+)?-pro/.test(version) && policy.values.includes("minimal")) { fail("Minimal is not supported by this Gemini Pro route."); }
  if (/^claude-(?:sonnet-4-6|opus-4-[56])(?:@|$)/.test(version) && policy.values.includes("xhigh")) { fail("Xhigh is not supported by this Claude family."); }
  if (policy.default !== "provider-default" && !policy.values.includes(policy.default)) { fail("named effort default must belong to values."); }
  if (model.legacyEffortAliases !== undefined && !Array.isArray(model.legacyEffortAliases)) { fail("legacyEffortAliases must be an array."); }
  for (const alias of model.legacyEffortAliases ?? []) {
    if (!alias || typeof alias.id !== "string" || !/^[a-zA-Z0-9_.@-]{1,256}$/.test(alias.id)
      || typeof alias.displayName !== "string" || !alias.displayName.trim() || alias.displayName.length > 256
      || typeof alias.version !== "string" || !policy.values.includes(alias.effort)) { fail("malformed or disallowed legacy effort alias."); }
    const decoded = decodeBackend(model.vendor, alias.version);
    if (decoded.backend !== version || decoded.effort !== alias.effort) { fail(`alias '${alias.id}' must pin its declared effort on the same backend.`); }
  }
}

export interface CatalogIdentity { readonly canonical: ModelSpec; readonly alias?: LegacyEffortAlias }
export class EffortCatalog {
  readonly models: readonly ModelSpec[];
  private readonly identities = new Map<string, CatalogIdentity>();
  constructor(models: readonly ModelSpec[], transport: "direct" | "proxy" = "direct") {
    this.models = snapshot(models);
    for (const model of this.models) {
      validateEffortModel(model, transport);
      this.add(model.id, { canonical: model });
      for (const alias of model.legacyEffortAliases ?? []) { this.add(alias.id, { canonical: model, alias }); }
    }
  }
  private add(id: string, identity: CatalogIdentity): void {
    if (this.identities.has(id)) { throw new EffortError("invalid-catalog", `Duplicate canonical or alias ID '${id}'.`); }
    this.identities.set(id, identity);
  }
  get(id: string): CatalogIdentity | undefined { return this.identities.get(id); }
  /** Model selectors expose regular models; effort is configured independently. */
  project(): ModelSpec[] {
    return this.models.filter((model) => !decodeBackend(model.vendor, model.version).effort);
  }
}

/** Keep readable custom catalogs authoritative, quarantining every colliding definition. */
export function filterLocalEffortModels(models: ModelSpec[], report: (message: string) => void): ModelSpec[] {
  const invalid = new Set<ModelSpec>();
  const owners = new Map<string, ModelSpec[]>();
  for (const model of models) {
    if (!model || typeof model !== "object") { invalid.add(model); report("Malformed model definition in custom catalog."); continue; }
    try { validateEffortModel(model); } catch (error) { invalid.add(model); report(String(error)); }
    const ids = [model.id, ...(Array.isArray(model.legacyEffortAliases) ? model.legacyEffortAliases.map((alias) => alias?.id) : [])];
    for (const id of ids) {
      const previous = owners.get(id) ?? [];
      previous.push(model);
      owners.set(id, previous);
    }
  }
  for (const [id, entries] of owners) {
    if (entries.length > 1) { entries.forEach((model) => invalid.add(model)); report(`Duplicate canonical or alias ID '${id}'.`); }
  }
  return models.filter((model) => !invalid.has(model));
}
