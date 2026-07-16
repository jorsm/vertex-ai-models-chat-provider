import * as childProcess from "child_process";
import * as fs from "fs";
import * as util from "util";
import * as vscode from "vscode";
import { Logger } from "./utils/Logger";

const execFileAsync = util.promisify(childProcess.execFile);

export type AuthMethodType = "secret" | "file" | "adc";

export interface AuthMethod {
  type: AuthMethodType;
  value?: string;
}

export interface AuthOptions {
  credentials?: any;
  keyFilename?: string;
  projectId?: string;
}

export class AuthConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthConfigurationError";
  }
}

const SECRETS_PREFIX = "sa_key_";
const GLOBAL_INDEX_KEY = "vertexAiChat.serviceAccountNames";
const WORKSPACE_AUTH_METHOD_KEY = "vertexAiChat.activeAuthMethod";

interface ServiceAccountCredentials {
  type: "service_account";
  project_id: string;
  client_email: string;
  private_key: string;
  [key: string]: unknown;
}

export class AuthManager {
  private readonly logger = new Logger("AuthManager");
  private readonly _onAuthUpdated = new vscode.EventEmitter<void>();
  public readonly onAuthUpdated = this._onAuthUpdated.event;

  constructor(private readonly context: vscode.ExtensionContext) {
    // No output channel creation needed
  }

  /**
   * Returns the raw authentication method configuration for the current workspace.
   */
  public getActiveMethod(): AuthMethod | undefined {
    return this.context.workspaceState.get<AuthMethod>(WORKSPACE_AUTH_METHOD_KEY);
  }

  /**
   * Resolves the current authentication options based on workspace selection.
   */
  public async getResolvedAuthOptions(): Promise<AuthOptions | undefined> {
    const authMethod = this.context.workspaceState.get<AuthMethod>(WORKSPACE_AUTH_METHOD_KEY);

    // Explicit selections fail closed. Never replace a missing selected
    // credential with an ambient ADC identity.
    if (authMethod?.type === "secret") {
      if (!authMethod.value) {
        this.logger.log("Secret auth selected but no name provided.");
        throw new AuthConfigurationError("The selected Service Account is missing its stored name. Select an authentication method to continue.");
      }
      const secret = await this.context.secrets.get(SECRETS_PREFIX + authMethod.value);
      if (!secret) {
        this.logger.log(`Secret '${authMethod.value}' not found in storage.`);
        throw new AuthConfigurationError(`Stored Service Account '${authMethod.value}' is unavailable. Select an authentication method to continue.`);
      }

      try {
        const credentials = this.parseServiceAccount(secret);
        this.logger.log(`Using Service Account secret: ${authMethod.value}`);
        return { credentials, projectId: credentials.project_id };
      } catch (e) {
        this.logger.log(`Error parsing secret '${authMethod.value}': ${e}`);
        throw new AuthConfigurationError(`Stored Service Account '${authMethod.value}' is invalid. Re-import or remove it before continuing.`);
      }
    }

    if (authMethod?.type === "file") {
      if (!authMethod.value) {
        this.logger.log("File auth selected but no path provided.");
        throw new AuthConfigurationError("The legacy Service Account file selection has no path. Select an authentication method to continue.");
      }
      const options = this.resolveFromFile(authMethod.value);
      if (!options) {
        throw new AuthConfigurationError(`Legacy Service Account file '${authMethod.value}' is unavailable or invalid. Select an authentication method to continue.`);
      }
      return options;
    }

    if (authMethod?.type === "adc") {
      this.logger.log("Using standard Application Default Credentials (ADC).");
      return undefined;
    }

    // 2. Default Behavior: Environment Variable Fallback
    const envPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (envPath) {
      const options = this.resolveFromFile(envPath);
      if (options) {
        this.logger.log(`Using GOOGLE_APPLICATION_CREDENTIALS: ${envPath}`);
        return options;
      }
    }

    this.logger.log("No explicit auth method set, using standard Application Default Credentials (ADC).");
    return undefined;
  }

  /** Legacy support for workspaces that stored a linked credential path. */
  private resolveFromFile(filePath: string): AuthOptions | undefined {
    if (fs.existsSync(filePath)) {
      try {
        const content = fs.readFileSync(filePath, "utf8");
        const credentials = JSON.parse(content);
        return { keyFilename: filePath, credentials, projectId: credentials.project_id };
      } catch (e) {
        this.logger.log(`Error reading/parsing file '${filePath}': ${e}`);
      }
    }
    return undefined;
  }

  /**
   * Command: Paste a new Service Account JSON key.
   */
  public async setServiceAccountKey(): Promise<boolean> {
    const json = await vscode.window.showInputBox({
      prompt: "Paste the content of your Service Account JSON key",
      placeHolder: '{ "type": "service_account", ... }',
      ignoreFocusOut: true,
      password: true,
      validateInput: (value) => {
        try {
          this.parseServiceAccount(value);
          return null;
        } catch (e: any) {
          return e.message || "Invalid service account JSON";
        }
      },
    });

    if (!json) {
      return false;
    }

    const credentials = this.parseServiceAccount(json);
    return this.storeServiceAccount(json, credentials.project_id || vscode.workspace.name || "default");
  }

  /**
   * Command: Import a Service Account JSON file into VS Code SecretStorage.
   * The selected file is a snapshot; subsequent file edits require re-importing it.
   */
  public async importServiceAccountFile(): Promise<boolean> {
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: { JSON: ["json"] },
      title: "Import Service Account JSON into VS Code Secret Storage",
      openLabel: "Import Credential",
    });

    if (!uris || uris.length === 0) {
      return false;
    }

    try {
      const bytes = await vscode.workspace.fs.readFile(uris[0]);
      const json = new TextDecoder().decode(bytes);
      const credentials = this.parseServiceAccount(json);
      return await this.storeServiceAccount(json, credentials.project_id || vscode.workspace.name || "default", true);
    } catch (e: any) {
      this.logger.log(`Failed to import service account file '${uris[0].toString()}': ${e}`);
      vscode.window.showErrorMessage(`Vertex AI: Could not import the service account file. ${e.message || e}`);
      return false;
    }
  }

  /** Backwards-compatible method name for callers using the previous API. */
  public async setServiceAccountPath(): Promise<boolean> {
    return this.importServiceAccountFile();
  }

  /**
   * Command: Remove a stored Service Account secret.
   */
  public async removeServiceAccount(): Promise<boolean> {
    const names = this.context.globalState.get<string[]>(GLOBAL_INDEX_KEY) || [];
    if (names.length === 0) {
      vscode.window.showInformationMessage("Vertex AI: No stored Service Accounts to remove.");
      return false;
    }

    const name = await vscode.window.showQuickPick(names, {
      placeHolder: "Select a stored Service Account to remove",
    });
    if (!name) {
      return false;
    }

    const removeAction = "Remove";
    const confirmation = await vscode.window.showWarningMessage(`Remove stored Service Account '${name}'?`, { modal: true }, removeAction);
    if (confirmation !== removeAction) {
      return false;
    }

    await this.context.secrets.delete(SECRETS_PREFIX + name);
    await this.context.globalState.update(
      GLOBAL_INDEX_KEY,
      names.filter((candidate) => candidate !== name),
    );

    const active = this.context.workspaceState.get<AuthMethod>(WORKSPACE_AUTH_METHOD_KEY);
    const removedActiveCredential = active?.type === "secret" && active.value === name;
    if (removedActiveCredential) {
      await this.context.workspaceState.update(WORKSPACE_AUTH_METHOD_KEY, { type: "adc" });
      this._onAuthUpdated.fire();
    }

    vscode.window.showInformationMessage(`Vertex AI: Removed Service Account '${name}' from this extension. No Google Cloud keys or resources were changed.`);
    return removedActiveCredential;
  }

  /**
   * Command: Pick from known secrets, files, or ADC.
   */
  public async selectAuthMethod(): Promise<boolean> {
    const names = this.context.globalState.get<string[]>(GLOBAL_INDEX_KEY) || [];
    const current = this.context.workspaceState.get<AuthMethod>(WORKSPACE_AUTH_METHOD_KEY);

    const items: vscode.QuickPickItem[] = [
      {
        label: "$(cloud) Use Default Credentials (gcloud login)",
        description: current?.type === "adc" || !current ? "(Current)" : "",
        alwaysShow: true,
      },
      {
        label: "$(file) Import Service Account JSON File...",
        description: "Store a secure snapshot in VS Code",
      },
    ];

    if (names.length > 0) {
      items.push({ label: "Stored Secrets", kind: vscode.QuickPickItemKind.Separator });
      for (const name of names) {
        items.push({
          label: `$(key) ${name}`,
          description: current?.type === "secret" && current.value === name ? "(Current)" : "",
        });
      }
      items.push({
        label: "$(trash) Remove Stored Service Account...",
        description: "Delete a credential from VS Code Secret Storage",
      });
    }

    const selection = await vscode.window.showQuickPick(items, {
      placeHolder: "Select Authentication Method for this Workspace",
    });

    if (!selection) {
      return false;
    }

    if (selection.label.includes("gcloud login")) {
      await this.context.workspaceState.update(WORKSPACE_AUTH_METHOD_KEY, { type: "adc" });
    } else if (selection.label.includes("Import Service Account")) {
      return this.importServiceAccountFile();
    } else if (selection.label.includes("Remove Stored Service Account")) {
      return this.removeServiceAccount();
    } else if (selection.label.startsWith("$(key)")) {
      const name = selection.label.replace("$(key) ", "");
      await this.context.workspaceState.update(WORKSPACE_AUTH_METHOD_KEY, { type: "secret", value: name });
    }

    this._onAuthUpdated.fire();
    return true;
  }

  /**
   * Command: Clear any custom auth and return to ADC.
   */
  public async clearAuthMethod(): Promise<void> {
    await this.context.workspaceState.update(WORKSPACE_AUTH_METHOD_KEY, { type: "adc" });
    this._onAuthUpdated.fire();
    vscode.window.showInformationMessage("Vertex AI: Authentication reset to Application Default Credentials.");
  }

  /**
   * Extracts the user email/identity from the active method.
   */
  public async getIdentity(): Promise<string | undefined> {
    const authOptions = await this.getResolvedAuthOptions();
    if (authOptions?.credentials?.client_email) {
      return authOptions.credentials.client_email;
    }

    // Fallback to gcloud if using ADC
    try {
      const { stdout } = await execFileAsync("gcloud", ["config", "get-value", "account"]);
      const email = stdout.trim();
      if (email && email !== "(unset)") {
        return email;
      }
    } catch (e) {
      this.logger.log(`Failed to get gcloud account email: ${e}`);
    }
    return undefined;
  }

  /** Runs gcloud authentication in the workspace extension host's terminal. */
  public async reauthenticate(projectId: string, onSuccess?: () => void | Promise<void>): Promise<void> {
    this.openGcloudLoginTerminal(projectId, onSuccess);
  }

  private parseServiceAccount(json: string): ServiceAccountCredentials {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new Error("Invalid JSON format");
    }

    if (typeof parsed !== "object" || parsed === null || (parsed as Record<string, unknown>).type !== "service_account") {
      throw new Error("Not a valid service account JSON (missing type: service_account)");
    }

    const credentials = parsed as ServiceAccountCredentials;
    if (typeof credentials.project_id !== "string" || typeof credentials.client_email !== "string" || typeof credentials.private_key !== "string" || !credentials.project_id || !credentials.client_email || !credentials.private_key) {
      throw new Error("Service account JSON is missing project_id, client_email, or private_key");
    }
    return credentials;
  }

  public getGcloudLoginActionLabel(): string {
    return "Login with gcloud";
  }

  private async storeServiceAccount(json: string, suggestedName: string, importedFromFile = false): Promise<boolean> {
    const enteredName = await vscode.window.showInputBox({
      prompt: "Enter a friendly name for this Service Account",
      value: suggestedName,
      placeHolder: "e.g. Client-A, Personal-Lab",
      validateInput: (value) => (value.trim().length === 0 ? "Enter a non-empty name" : null),
    });
    if (!enteredName) {
      return false;
    }
    const name = enteredName.trim();

    const names = this.context.globalState.get<string[]>(GLOBAL_INDEX_KEY) || [];
    if (names.includes(name)) {
      const replaceAction = "Replace";
      const confirmation = await vscode.window.showWarningMessage(`A stored Service Account named '${name}' already exists. Replace it with this imported credential?`, { modal: true }, replaceAction);
      if (confirmation !== replaceAction) {
        return false;
      }
    }

    await this.context.secrets.store(SECRETS_PREFIX + name, json);
    if (!names.includes(name)) {
      await this.context.globalState.update(GLOBAL_INDEX_KEY, [...names, name]);
    }
    await this.context.workspaceState.update(WORKSPACE_AUTH_METHOD_KEY, { type: "secret", value: name });
    this._onAuthUpdated.fire();
    const sourceFileNotice = importedFromFile ? " The original credential file was not modified; delete it yourself if it is no longer needed." : "";
    vscode.window.showInformationMessage(`Vertex AI: Service Account '${name}' securely stored and activated for this workspace.${sourceFileNotice}`);
    return true;
  }

  private getGcloudLoginArgs(projectId: string): string[] {
    const args = ["auth", "application-default", "login"];
    if (projectId) {
      args.push("--project", projectId);
    }
    args.push("--quiet");
    return args;
  }

  private openGcloudLoginTerminal(projectId: string, onSuccess?: () => void | Promise<void>): void {
    const terminal = vscode.window.createTerminal({
      name: "Vertex AI: Authentication",
      iconPath: new vscode.ThemeIcon("key"),
    });

    const args = this.getGcloudLoginArgs(projectId);
    const command = ["gcloud", ...args.map((arg) => this.quoteShellArgument(arg))].join(" ");
    let completed = false;
    const cleanup = () => {
      endListener.dispose();
      closeListener.dispose();
    };
    const endListener = vscode.window.onDidEndTerminalShellExecution((event) => {
      if (event.terminal !== terminal || completed || !event.execution.commandLine.value.includes("gcloud auth application-default login")) {
        return;
      }
      completed = true;
      cleanup();
      if (event.exitCode !== 0) {
        vscode.window.showErrorMessage(`Vertex AI: gcloud authentication failed${event.exitCode === undefined ? "" : ` with exit code ${event.exitCode}`}. Review the authentication terminal for details.`);
        return;
      }

      void (async () => {
        await this.activateAdc();
        vscode.window.showInformationMessage("Vertex AI: Application Default Credentials updated successfully. Refreshing models…");
        await onSuccess?.();
      })().catch((error) => this.logger.log(`Post-authentication refresh failed: ${error}`));
    });
    const closeListener = vscode.window.onDidCloseTerminal((closedTerminal) => {
      if (closedTerminal === terminal) {
        cleanup();
      }
    });

    terminal.show();
    terminal.sendText(command);
    vscode.window.showInformationMessage("Vertex AI: Complete gcloud authentication in the terminal. Models will refresh automatically when shell integration reports success; otherwise run Refresh Models.");
  }

  private quoteShellArgument(value: string): string {
    if (/^[A-Za-z0-9._:/=-]+$/.test(value)) {
      return value;
    }
    return `'${value.replace(/'/g, `'\\''`)}'`;
  }

  private async activateAdc(): Promise<void> {
    await this.context.workspaceState.update(WORKSPACE_AUTH_METHOD_KEY, { type: "adc" });
    this._onAuthUpdated.fire();
  }
}
