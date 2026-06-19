import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import bundledCatalog from "./models.json";
import { Logger } from "./utils/Logger";
import { ModelCatalog } from "./VertexChatModelDispatcher";

/**
 * Resolves the effective model catalog at runtime with precedence:
 *   Workspace (.vscode/models.json)  >  User (globalStorageUri/models.json)  >  Bundled (src/models.json)
 *
 * A custom file fully *replaces* the bundled catalog (it is not merged). The bundled
 * catalog is used only as the seed template when a custom file is first created, and as
 * the final fallback when no custom file exists or a custom file fails to parse.
 *
 * Both custom file paths are deterministic and covered by `contributes.jsonValidation`
 * globs in package.json, so they get full JSON schema validation + autocomplete in the editor.
 */
export class ModelCatalogResolver implements vscode.Disposable {
  private readonly logger = new Logger("ModelCatalogResolver");
  private readonly userCatalogUri: vscode.Uri;
  private readonly userCatalogPath: string;

  /** Cached effective catalog + its source. Invalidated by `invalidateCache()` (e.g. on file save). */
  private cached: { catalog: ModelCatalog; source: "workspace" | "user" | "bundled" } | null = null;

  /** Suppresses repeated error popups for the same broken file until it changes. */
  private lastErroredPath: string | null = null;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.userCatalogUri = vscode.Uri.joinPath(context.globalStorageUri, "models.json");
    this.userCatalogPath = this.userCatalogUri.fsPath;
  }

  dispose(): void {
    // No long-lived resources held here; watchers are owned by extension.ts.
  }

  // ── URI helpers ───────────────────────────────────────────────────────

  /**
   * URI of the workspace-level catalog for the first workspace folder, or `undefined`
   * when no workspace folder is open. Does NOT create the file.
   */
  getWorkspaceCatalogUri(): vscode.Uri | undefined {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      return undefined;
    }
    return vscode.Uri.joinPath(folder.uri, ".vscode", "models.json");
  }

  /** URI of the user-level catalog in the extension's global storage. Does NOT create the file. */
  getUserCatalogUri(): vscode.Uri {
    return this.userCatalogUri;
  }

  // ── Seeding (used by the open-file commands) ──────────────────────────

  /**
   * Ensures the user-level catalog exists, seeding it from the bundled catalog if absent.
   * Returns the URI of the (now-existing) file.
   */
  async ensureUserCatalogExists(): Promise<vscode.Uri> {
    await this.ensureStorageDir();
    await this.seedIfAbsent(this.userCatalogPath);
    this.invalidateCache();
    return this.userCatalogUri;
  }

  /**
   * Ensures the workspace-level catalog exists for the first workspace folder, seeding it
   * from the bundled catalog if absent. Returns `undefined` if no workspace folder is open.
   */
  async ensureWorkspaceCatalogExists(): Promise<vscode.Uri | undefined> {
    const uri = this.getWorkspaceCatalogUri();
    if (!uri) {
      return undefined;
    }
    const filePath = uri.fsPath;
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await this.seedIfAbsent(filePath);
    this.invalidateCache();
    return uri;
  }

  // ── Effective catalog resolution ──────────────────────────────────────

  /**
   * Returns the effective catalog following the Workspace > User > Bundled precedence.
   * Results are cached until `invalidateCache()` is called. On a parse error in a custom
   * file, logs the error, shows a one-shot error message, and falls back to the next tier
   * (never throws — callers always get a usable catalog).
   */
  getEffectiveCatalog(): ModelCatalog {
    if (this.cached) {
      return this.cached.catalog;
    }

    // 1. Workspace
    const wsUri = this.getWorkspaceCatalogUri();
    if (wsUri) {
      const parsed = this.tryReadAndParse(wsUri.fsPath, "workspace");
      if (parsed) {
        this.cached = { catalog: parsed, source: "workspace" };
        return parsed;
      }
    }

    // 2. User
    const parsed = this.tryReadAndParse(this.userCatalogPath, "user");
    if (parsed) {
      this.cached = { catalog: parsed, source: "user" };
      return parsed;
    }

    // 3. Bundled fallback
    this.cached = { catalog: bundledCatalog as ModelCatalog, source: "bundled" };
    return this.cached.catalog;
  }

  /** Clears the cache so the next `getEffectiveCatalog()` re-reads from disk. */
  invalidateCache(): void {
    this.cached = null;
  }

  // ── Internals ─────────────────────────────────────────────────────────

  private async ensureStorageDir(): Promise<void> {
    try {
      await fs.access(this.context.globalStorageUri.fsPath);
    } catch {
      await fs.mkdir(this.context.globalStorageUri.fsPath, { recursive: true });
    }
  }

  /**
   * Writes the bundled catalog (pretty-printed) to `filePath` only if it does not already exist.
   * Never overwrites an existing custom file.
   */
  private async seedIfAbsent(filePath: string): Promise<void> {
    try {
      await fs.access(filePath);
      return; // already exists — leave the user's edits alone
    } catch {
      // not found — seed
    }
    const seed = JSON.stringify(bundledCatalog, null, 2);
    await fs.writeFile(filePath, seed, "utf8");
    this.logger.log(`Seeded custom models.json from bundled catalog at: ${filePath}`);
  }

  /**
   * Synchronously reads + parses a custom catalog file. Returns `null` if the file is
   * absent, fails to parse, or doesn't match the `ModelCatalog` shape. Handles error
   * reporting with a one-shot popup per file path.
   */
  private tryReadAndParse(filePath: string, _tier: "workspace" | "user"): ModelCatalog | null {
    let raw: string;
    try {
      raw = require("fs").readFileSync(filePath, "utf8");
    } catch {
      // File doesn't exist (or unreadable) — not an error, just absent.
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e: any) {
      this.reportParseError(filePath, `Invalid JSON: ${e.message || e}`);
      return null;
    }

    if (!this.isValidCatalog(parsed)) {
      this.reportParseError(filePath, "Missing required 'candidateModels' array or 'regionPriority' array.");
      return null;
    }

    return parsed as ModelCatalog;
  }

  private isValidCatalog(value: unknown): value is ModelCatalog {
    if (typeof value !== "object" || value === null) {
      return false;
    }
    const v = value as Record<string, unknown>;
    return Array.isArray(v.candidateModels) && Array.isArray(v.regionPriority);
  }

  private reportParseError(filePath: string, detail: string): void {
    this.logger.log(`⚠️  Custom models.json parse error at ${filePath}: ${detail}. Falling back to next catalog tier.`);
    if (this.lastErroredPath !== filePath) {
      this.lastErroredPath = filePath;
      vscode.window.showErrorMessage(`Google Agent Platform: Could not parse "${filePath}". ${detail} Using fallback models. Fix the file and save to retry.`);
    }
  }
}
