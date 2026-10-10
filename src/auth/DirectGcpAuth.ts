import * as fs from "fs";
import * as vscode from "vscode";
import type { Logger } from "../utils/Logger";

/** Supported sources for authenticating Vertex AI requests. */
export type AuthMethodType = "secret" | "file" | "adc";

/**
 * Describes the authentication source selected for the current workspace.
 *
 * @remarks
 * `value` is a stored Service Account name for `secret`, a credential path for
 * `file`, and unused for `adc`.
 */
export interface AuthMethod {
    type: AuthMethodType;
    value?: string;
}

/**
 * Google authentication options passed to the Vertex AI client.
 *
 * @remarks
 * An undefined result from {@link DirectGcpAuth.getResolvedAuthOptions} means to use ADC.
 */
export interface AuthOptions {
    /** Parsed Service Account JSON credentials, when using a key. */
    credentials?: any;
    /** Path to a Service Account JSON key file, when credentials are read from disk. */
    keyFilename?: string;
    /** Project associated with the selected credentials, when available. */
    projectId?: string;
}

/**
 * Raised when a workspace's explicitly selected credential is unavailable or invalid.
 *
 * @remarks
 * This error preserves explicit credential selection instead of allowing fallback to ambient ADC.
 */
export class AuthConfigurationError extends Error {
    /**
     * Creates an error for a credential that cannot be resolved as selected.
     *
     * @param message - User-facing explanation of the authentication configuration problem.
     */
    constructor(message: string) {
        super(message);
        this.name = "AuthConfigurationError";
    }
}

const SECRETS_PREFIX = "sa_key_";

const GLOBAL_INDEX_KEY = "vertexAiChat.serviceAccountNames";

const WORKSPACE_AUTH_METHOD_KEY = "vertexAiChat.activeAuthMethod";

/** Required identity and key fields validated before a credential is stored. */
interface ServiceAccountCredentials {
    type: "service_account";
    project_id: string;
    client_email: string;
    private_key: string;
    [key: string]: unknown;
}

/**
 * Manages direct Vertex authentication selection and Service Account credentials.
 * Secrets are stored in VS Code SecretStorage, while the selected method is
 * stored per workspace. Explicitly selected credentials fail closed instead
 * of silently falling back to ambient ADC.
 *
 * @remarks
 * When no method is selected, credential resolution tries
 * `GOOGLE_APPLICATION_CREDENTIALS` and uses it when the file can be read and
 * parsed; otherwise it uses ADC. See {@link DirectGcpAuth.getResolvedAuthOptions}.
 */
export class DirectGcpAuth {
    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly notifyAuthUpdated: () => void,
        private readonly logger: Logger,
    ) {}

    /**
     * Returns the raw authentication method configuration for the current workspace.
     *
     * @returns The selected method, or `undefined` if this workspace has no saved selection.
     */
    public getActiveMethod(): AuthMethod | undefined {
        return this.context.workspaceState.get<AuthMethod>(WORKSPACE_AUTH_METHOD_KEY);
    }

    /**
     * Resolves the selected workspace credential, or the default credential
     * source when no explicit method is selected. Returns undefined for ADC;
     * missing or invalid selected secrets, and unavailable or unparseable
     * selected files, throw AuthConfigurationError.
     *
     * @returns Credential options, or `undefined` when ADC should be used.
     * @throws {@link AuthConfigurationError}
     * If a selected secret is missing or invalid, or a selected file is
     *     unavailable or cannot be parsed.
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

    /**
     * Prompts for a Service Account JSON key, stores it securely, and activates it for this workspace.
     *
     * @returns `true` if the key was stored and activated; otherwise `false` if a prompt was canceled or replacement was declined.
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
     * A successful import is stored and activated for the current workspace.
     *
     * @returns `true` if the credential was imported and activated; otherwise
     * `false` if a prompt was canceled, replacement was declined, or import failed.
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

        const uri = uris?.[0];
        if (!uri) {
            return false;
        }

        try {
            const bytes = await vscode.workspace.fs.readFile(uri);
            const json = new TextDecoder().decode(bytes);
            const credentials = this.parseServiceAccount(json);
            return await this.storeServiceAccount(json, credentials.project_id || vscode.workspace.name || "default", true);
        } catch (e: any) {
            this.logger.log(`Failed to import service account file '${uri.toString()}': ${e}`);
            void vscode.window.showErrorMessage(`Vertex AI: Could not import the service account file. ${e.message || e}`);
            return false;
        }
    }

    /**
     * Backwards-compatible method name for callers using the previous API.
     *
     * @returns Whether the import succeeded and activated a credential.
     * @see {@link DirectGcpAuth.importServiceAccountFile}
     */
    public async setServiceAccountPath(): Promise<boolean> {
        return this.importServiceAccountFile();
    }

    /**
     * Prompts to remove a stored Service Account secret from this extension.
     *
     * @returns `true` if the removed credential was active in this workspace;
     * `false` if removal was canceled or the removed credential was inactive.
     * @remarks
     * Removal deletes only the extension's stored copy and name entry.
     * It does not change Google Cloud keys or resources. If the credential was
     * active in this workspace, this workspace is reset to ADC.
     */
    public async removeServiceAccount(): Promise<boolean> {
        const names = this.context.globalState.get<string[]>(GLOBAL_INDEX_KEY) || [];
        if (names.length === 0) {
            void vscode.window.showInformationMessage("Vertex AI: No stored Service Accounts to remove.");
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
            this.notifyAuthUpdated();
        }

        void vscode.window.showInformationMessage(`Vertex AI: Removed Service Account '${name}' from this extension. No Google Cloud keys or resources were changed.`);
        return removedActiveCredential;
    }

    /**
     * Prompts for a workspace authentication method and persists the selection.
     *
     * @returns `true` if a method was selected or the active credential was removed;
     * `false` if canceled or a delegated import/removal operation returns false.
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

        this.notifyAuthUpdated();
        return true;
    }

    /**
     * Resets this workspace's authentication selection to Application Default Credentials.
     *
     * @remarks
     * Stored Service Account credentials remain available for later selection.
     */
    public async clearAuthMethod(): Promise<void> {
        await this.context.workspaceState.update(WORKSPACE_AUTH_METHOD_KEY, { type: "adc" });
        this.notifyAuthUpdated();
        void vscode.window.showInformationMessage("Vertex AI: Authentication reset to Application Default Credentials.");
    }

    /**
     * Opens a terminal for `gcloud auth application-default login` in the
     * workspace extension host. Resolves after starting the terminal; an
     * optional callback runs after shell integration reports successful login.
     *
     * @param projectId - Project ID to pass to the gcloud login command, if non-empty.
     * @param onSuccess - Optional callback run after successful login activates ADC.
     * @returns Resolves after the terminal command is started, not after login completes.
     */
    public async reauthenticate(projectId: string, onSuccess?: () => void | Promise<void>): Promise<void> {
        this.openGcloudLoginTerminal(projectId, onSuccess);
    }

    /**
     * Returns the label used for the gcloud sign-in action in authentication UI.
     *
     * @returns The label shown for the gcloud sign-in action.
     */
    public getGcloudLoginActionLabel(): string {
        return "Login with gcloud";
    }

    /**
     * Resolves a credential file reference used by a legacy selection or the
     * `GOOGLE_APPLICATION_CREDENTIALS` environment variable.
     *
     * @param filePath - Path to the Service Account JSON file.
     * @returns Credential options when the file exists and contains parseable JSON; otherwise `undefined`.
     */
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
     * Parses Service Account JSON and checks its required identity and key fields.
     *
     * @param json - Raw Service Account JSON text.
     * @returns Parsed credentials containing the project, client email, and private key.
     * @throws {@link Error}
     * If the JSON is malformed or required Service Account fields are missing.
     */
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

    /**
     * Stores a Service Account credential and activates it for the current workspace.
     *
     * @param json - Validated Service Account JSON to store in SecretStorage.
     * @param suggestedName - Initial display name shown in the name prompt.
     * @param importedFromFile - Whether to tell the user that the source file remains unchanged.
     * @returns `true` if stored and activated; otherwise `false` if canceled or replacement declined.
     */
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
            await this.context.globalState.update(GLOBAL_INDEX_KEY, [
                ...names,
                name,
            ]);
        }
        await this.context.workspaceState.update(WORKSPACE_AUTH_METHOD_KEY, { type: "secret", value: name });
        this.notifyAuthUpdated();
        const sourceFileNotice = importedFromFile ? " The original credential file was not modified; delete it yourself if it is no longer needed." : "";
        void vscode.window.showInformationMessage(`Vertex AI: Service Account '${name}' securely stored and activated for this workspace.${sourceFileNotice}`);
        return true;
    }

    /**
     * Builds arguments for `gcloud auth application-default login`.
     *
     * @param projectId - Optional project ID to include in the command.
     * @returns The command arguments, including `--quiet` and `--project` when applicable.
     */
    private getGcloudLoginArgs(projectId: string): string[] {
        const args = [
            "auth",
            "application-default",
            "login",
        ];
        if (projectId) {
            args.push("--project", projectId);
        }
        args.push("--quiet");
        return args;
    }

    /**
     * Starts ADC login in a dedicated VS Code terminal and observes shell integration events.
     *
     * @param projectId - Project ID to pass to the login command, if non-empty.
     * @param onSuccess - Optional callback to run after successful login and ADC activation.
     * @remarks
     * If shell integration does not report completion, the user must refresh models manually.
     * @see {@link DirectGcpAuth.reauthenticate}
     */
    private openGcloudLoginTerminal(projectId: string, onSuccess?: () => void | Promise<void>): void {
        const terminal = vscode.window.createTerminal({
            name: "Vertex AI: Authentication",
            iconPath: new vscode.ThemeIcon("key"),
        });

        const args = this.getGcloudLoginArgs(projectId);
        const command = [
            "gcloud",
            ...args.map((arg) => this.quoteShellArgument(arg)),
        ].join(" ");
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
                void vscode.window.showErrorMessage(`Vertex AI: gcloud authentication failed${event.exitCode === undefined ? "" : ` with exit code ${event.exitCode}`}. Review the authentication terminal for details.`);
                return;
            }

            void (async () => {
                await this.activateAdc();
                void vscode.window.showInformationMessage("Vertex AI: Application Default Credentials updated successfully. Refreshing models…");
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
        void vscode.window.showInformationMessage("Vertex AI: Complete gcloud authentication in the terminal. Models will refresh automatically when shell integration reports success; otherwise run Refresh Models.");
    }

    /**
     * Formats one argument for inclusion in the gcloud terminal command.
     *
     * @param value - Argument value to format.
     * @returns The original value when it contains only whitelisted characters,
     *     or a single-quoted form with embedded single quotes escaped otherwise.
     */
    private quoteShellArgument(value: string): string {
        if (/^[A-Za-z0-9._:/=-]+$/.test(value)) {
            return value;
        }
        return `'${value.replace(/'/g, `'\\''`)}'`;
    }

    /** Selects ADC for this workspace and invalidates cached identity data. */
    private async activateAdc(): Promise<void> {
        await this.context.workspaceState.update(WORKSPACE_AUTH_METHOD_KEY, { type: "adc" });
        this.notifyAuthUpdated();
    }
}
