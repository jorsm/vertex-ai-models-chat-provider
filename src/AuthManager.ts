import * as childProcess from "child_process";
import * as fs from "fs";
import * as util from "util";
import * as vscode from "vscode";

const execAsync = util.promisify(childProcess.exec);

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

const SECRETS_PREFIX = "sa_key_";
const GLOBAL_INDEX_KEY = "vertexAiChat.serviceAccountNames";
const WORKSPACE_AUTH_METHOD_KEY = "vertexAiChat.activeAuthMethod";
const SUPPRESS_WARNING_KEY = "vertexAiChat.suppressAuthWarning";

export class AuthManager {
  private readonly outputChannel: vscode.OutputChannel;
  private readonly _onAuthUpdated = new vscode.EventEmitter<void>();
  public readonly onAuthUpdated = this._onAuthUpdated.event;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.outputChannel = vscode.window.createOutputChannel("Vertex AI: Auth");
  }

  private log(msg: string): void {
    const ts = new Date().toISOString();
    this.outputChannel.appendLine(`[${ts}] ${msg}`);
  }

  /**
   * Resolves the current authentication options based on workspace selection.
   */
  public async getResolvedAuthOptions(): Promise<AuthOptions | undefined> {
    const authMethod = this.context.workspaceState.get<AuthMethod>(WORKSPACE_AUTH_METHOD_KEY);

    // 1. Explicit selection (Secret or File)
    if (authMethod?.type === "secret") {
      if (!authMethod.value) {
        this.log("Secret auth selected but no name provided.");
        return undefined;
      }
      const secret = await this.context.secrets.get(SECRETS_PREFIX + authMethod.value);
      if (secret) {
        try {
          const credentials = JSON.parse(secret);
          this.log(`Using Service Account secret: ${authMethod.value}`);
          return { credentials, projectId: credentials.project_id };
        } catch (e) {
          this.log(`Error parsing secret '${authMethod.value}': ${e}`);
          await this.showFallbackWarning(`secret '${authMethod.value}'`);
          /* 
           * DESIGN CHOICE: We return undefined here to trigger the standard ADC fallback. 
           * While this might seem "silent," the safety net is enforced in VertexChatModelDispatcher.
           * If the active ADC identity (e.g., a personal gcloud login) does not have explicit 
           * access to the Project ID set in VS Code settings, the Model Discovery/Ping 
           * will fail loudly, clearing the model list and notifying the user.
           * This prevents accidental billing on the wrong project while allowing recovery.
           */
        }
      } else {
        this.log(`Secret '${authMethod.value}' not found in storage.`);
        await this.showFallbackWarning(`secret '${authMethod.value}'`);
      }
      return undefined;
    }

    if (authMethod?.type === "file") {
      if (!authMethod.value) {
        this.log("File auth selected but no path provided.");
        return undefined;
      }
      const options = this.resolveFromFile(authMethod.value);
      if (!options) {
        await this.showFallbackWarning(`file '${authMethod.value}'`);
      }
      return options;
    }

    if (authMethod?.type === "adc") {
      this.log("Using standard Application Default Credentials (ADC).");
      return undefined;
    }

    // 2. Default Behavior: Environment Variable Fallback
    const envPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (envPath) {
      const options = this.resolveFromFile(envPath);
      if (options) {
        this.log(`Using GOOGLE_APPLICATION_CREDENTIALS: ${envPath}`);
        return options;
      }
    }

    this.log("No explicit auth method set, using standard Application Default Credentials (ADC).");
    return undefined;
  }

  private resolveFromFile(filePath: string): AuthOptions | undefined {
    if (fs.existsSync(filePath)) {
      try {
        const content = fs.readFileSync(filePath, "utf8");
        const credentials = JSON.parse(content);
        return { keyFilename: filePath, credentials, projectId: credentials.project_id };
      } catch (e) {
        this.log(`Error reading/parsing file '${filePath}': ${e}`);
      }
    }
    return undefined;
  }

  private async showFallbackWarning(methodDesc: string): Promise<void> {
    const suppress = this.context.workspaceState.get<boolean>(SUPPRESS_WARNING_KEY);
    if (suppress) {
      return;
    }

    const msg = `Vertex AI: Could not load ${methodDesc}. Falling back to Application Default Credentials.`;
    const dontShowAgain = "Don't Show Again";
    const selection = await vscode.window.showWarningMessage(msg, dontShowAgain);

    if (selection === dontShowAgain) {
      await this.context.workspaceState.update(SUPPRESS_WARNING_KEY, true);
    }
  }

  /**
   * Command: Paste a new Service Account JSON key.
   */
  public async setServiceAccountKey(): Promise<void> {
    const json = await vscode.window.showInputBox({
      prompt: "Paste the content of your Service Account JSON key",
      placeHolder: '{ "type": "service_account", ... }',
      ignoreFocusOut: true,
      validateInput: (value) => {
        try {
          const parsed = JSON.parse(value);
          if (parsed.type !== "service_account") {
            return "Not a valid service account JSON (missing type: service_account)";
          }
          return null;
        } catch (e) {
          return "Invalid JSON format";
        }
      },
    });

    if (!json) {
      return;
    }

    const defaultName = vscode.workspace.name || "default";
    const name = await vscode.window.showInputBox({
      prompt: "Enter a friendly name for this Service Account",
      value: defaultName,
      placeHolder: "e.g. Client-A, Personal-Lab",
    });

    if (!name) {
      return;
    }

    await this.context.secrets.store(SECRETS_PREFIX + name, json);

    // Update global index
    const names = this.context.globalState.get<string[]>(GLOBAL_INDEX_KEY) || [];
    if (!names.includes(name)) {
      names.push(name);
      await this.context.globalState.update(GLOBAL_INDEX_KEY, names);
    }

    await this.context.workspaceState.update(WORKSPACE_AUTH_METHOD_KEY, { type: "secret", value: name });
    await this.context.workspaceState.update(SUPPRESS_WARNING_KEY, false);
    this._onAuthUpdated.fire();
    vscode.window.showInformationMessage(`Vertex AI: Service Account '${name}' saved and activated for this workspace.`);
  }

  /**
   * Command: Select an existing Service Account JSON file.
   */
  public async setServiceAccountPath(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: { JSON: ["json"] },
      title: "Select Service Account JSON Key File",
    });

    if (!uris || uris.length === 0) {
      return;
    }

    const filePath = uris[0].fsPath;
    await this.context.workspaceState.update(WORKSPACE_AUTH_METHOD_KEY, { type: "file", value: filePath });
    await this.context.workspaceState.update(SUPPRESS_WARNING_KEY, false);
    this._onAuthUpdated.fire();
    vscode.window.showInformationMessage(`Vertex AI: Using Service Account file: ${filePath}`);
  }

  /**
   * Command: Pick from known secrets, files, or ADC.
   */
  public async selectAuthMethod(): Promise<void> {
    const names = this.context.globalState.get<string[]>(GLOBAL_INDEX_KEY) || [];
    const current = this.context.workspaceState.get<AuthMethod>(WORKSPACE_AUTH_METHOD_KEY);

    const items: vscode.QuickPickItem[] = [
      {
        label: "$(cloud) Use Default Credentials (gcloud login)",
        description: current?.type === "adc" || !current ? "(Current)" : "",
        alwaysShow: true,
      },
      {
        label: "$(file) Use Local File Path...",
        description: current?.type === "file" ? `(Current: ${current.value})` : "",
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
    }

    const selection = await vscode.window.showQuickPick(items, {
      placeHolder: "Select Authentication Method for this Workspace",
    });

    if (!selection) {
      return;
    }

    if (selection.label.includes("gcloud login")) {
      await this.context.workspaceState.update(WORKSPACE_AUTH_METHOD_KEY, { type: "adc" });
    } else if (selection.label.includes("Local File Path")) {
      await this.setServiceAccountPath();
    } else if (selection.label.startsWith("$(key)")) {
      const name = selection.label.replace("$(key) ", "");
      await this.context.workspaceState.update(WORKSPACE_AUTH_METHOD_KEY, { type: "secret", value: name });
    }

    await this.context.workspaceState.update(SUPPRESS_WARNING_KEY, false);
    this._onAuthUpdated.fire();
  }

  /**
   * Command: Clear any custom auth and return to ADC.
   */
  public async clearAuthMethod(): Promise<void> {
    await this.context.workspaceState.update(WORKSPACE_AUTH_METHOD_KEY, { type: "adc" });
    await this.context.workspaceState.update(SUPPRESS_WARNING_KEY, false);
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
      const { stdout } = await execAsync("gcloud config get-value account");
      const email = stdout.trim();
      if (email && email !== "(unset)") {
        return email;
      }
    } catch (e) {
      this.log(`Failed to get gcloud account email: ${e}`);
    }
    return undefined;
  }

  /**
   * Encapsulates the gcloud login terminal workflow.
   */
  public async reauthenticate(): Promise<void> {
    const terminal = vscode.window.createTerminal({
      name: "Vertex AI: Authentication",
      iconPath: new vscode.ThemeIcon("key"),
    });

    terminal.show();
    terminal.sendText("gcloud auth application-default login");

    // We can't easily wait for the terminal to finish here without complex state tracking,
    // but the extension.ts already has some logic for this using onDidStartTerminalShellExecution.
    // We'll keep that logic in extension.ts or move it if needed, but for now this triggers the command.
  }
}
