import { readFile } from "node:fs/promises";
import * as vscode from "vscode";
import type { Logger } from "../utils/Logger";
import { AuthConfigurationError, parseCredentialJson, parseServiceAccount } from "./AuthCredentials";
import type { AuthMethod, AuthOptions } from "./AuthCredentials";
import { openGcloudLoginTerminal } from "./GcloudLogin";

export { AuthConfigurationError } from "./AuthCredentials";
export type { AuthMethod, AuthMethodType, AuthOptions } from "./AuthCredentials";

/** Actions carried by authentication picker rows independently of their display labels. */
type AuthPickerAction = { type: "adc" | "import" | "remove" } | { type: "secret"; name: string };

/** Separators carry no action and cannot change the selected authentication method. */
interface AuthPickerItem extends vscode.QuickPickItem {
    action?: AuthPickerAction;
}

const SECRETS_PREFIX = "sa_key_";

const GLOBAL_INDEX_KEY = "vertexAiChat.serviceAccountNames";

const WORKSPACE_AUTH_METHOD_KEY = "vertexAiChat.activeAuthMethod";

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
    /**
     * @param context - Owns stored keys and the workspace authentication selection.
     * @param notifyAuthUpdated - Invalidates shared identity data after a selection changes.
     * @param logger - Receives credential-source diagnostics without credential contents.
     */
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
     * @param logAdc - Whether to log when falling back to Application Default Credentials.
     * @returns Credential options, or `undefined` when ADC should be used.
     * @throws An {@link AuthConfigurationError} if a selected secret is missing or
     * invalid, or a selected file is unavailable or cannot be parsed.
     */
    public async getResolvedAuthOptions(logAdc = true): Promise<AuthOptions | undefined> {
        const authMethod = this.getActiveMethod();

        // Explicit selections fail closed. Never replace a missing selected
        // credential with an ambient ADC identity.
        if (authMethod?.type === "secret") {
            return this.resolveStoredServiceAccount(authMethod.value);
        }

        if (authMethod?.type === "file") {
            if (!authMethod.value) {
                this.logger.log("File auth selected but no path provided.");
                throw new AuthConfigurationError("The legacy Service Account file selection has no path. Select an authentication method to continue.");
            }
            const options = await this.resolveFromFile(authMethod.value);
            if (!options) {
                throw new AuthConfigurationError(`Legacy Service Account file '${authMethod.value}' is unavailable or invalid. Select an authentication method to continue.`);
            }
            return options;
        }

        if (authMethod?.type === "adc") {
            if (logAdc) {
                this.logger.log("Using standard Application Default Credentials (ADC).");
            }
            return undefined;
        }

        // With no selection, try the environment credential file before ambient ADC.
        const envPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
        if (envPath) {
            const options = await this.resolveFromFile(envPath);
            if (options) {
                this.logger.log(`Using GOOGLE_APPLICATION_CREDENTIALS: ${envPath}`);
                return options;
            }
        }

        if (logAdc) {
            this.logger.log("No explicit auth method set, using standard Application Default Credentials (ADC).");
        }
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
                    parseServiceAccount(value);
                    return null;
                } catch (error) {
                    return error instanceof Error ? error.message : "Invalid service account JSON";
                }
            },
        });

        if (!json) {
            return false;
        }

        const credentials = parseServiceAccount(json);
        return this.storeServiceAccount(json, credentials.project_id);
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
            const credentials = parseServiceAccount(json);
            return await this.storeServiceAccount(json, credentials.project_id, true);
        } catch (error) {
            this.logger.log("Failed to import the Service Account file.");
            const message = error instanceof Error ? error.message : "The file could not be imported.";
            void vscode.window.showErrorMessage(`Vertex AI: Could not import the service account file. ${message}`);
            return false;
        }
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

        const active = this.getActiveMethod();
        const removedActiveCredential = active?.type === "secret" && active.value === name;
        if (removedActiveCredential) {
            await this.activateAdc();
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
        const current = this.getActiveMethod();

        const items: AuthPickerItem[] = [
            {
                label: "$(cloud) Use Default Credentials (gcloud login)",
                action: { type: "adc" },
                description: current?.type === "adc" || !current ? "(Current)" : "",
                alwaysShow: true,
            },
            {
                label: "$(file) Import Service Account JSON File...",
                action: { type: "import" },
                description: "Store a secure snapshot in VS Code",
            },
        ];

        if (names.length > 0) {
            items.push({ label: "Stored Secrets", kind: vscode.QuickPickItemKind.Separator });
            for (const name of names) {
                items.push({
                    label: `$(key) ${name}`,
                    action: { type: "secret", name },
                    description: current?.type === "secret" && current.value === name ? "(Current)" : "",
                });
            }
            items.push({
                label: "$(trash) Remove Stored Service Account...",
                action: { type: "remove" },
                description: "Delete a credential from VS Code Secret Storage",
            });
        }

        const selection = await vscode.window.showQuickPick(items, {
            placeHolder: "Select Authentication Method for this Workspace",
        });

        if (!selection?.action) {
            return false;
        }

        switch (selection.action.type) {
            case "import":
                return this.importServiceAccountFile();
            case "remove":
                return this.removeServiceAccount();
            case "secret":
                await this.context.workspaceState.update(WORKSPACE_AUTH_METHOD_KEY, { type: "secret", value: selection.action.name });
                break;
            case "adc":
                await this.activateAdc();
                return true;
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
        await this.activateAdc();
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
        openGcloudLoginTerminal(
            projectId,
            async () => {
                await this.activateAdc();
                void vscode.window.showInformationMessage("Vertex AI: Application Default Credentials updated successfully. Refreshing models…");
                await onSuccess?.();
            },
            this.logger,
        );
    }

    /**
     * Resolves a selected stored key without substituting another credential source.
     *
     * @param name - Stored name from the workspace selection, including legacy missing values.
     * @returns Validated Service Account credentials and their project ID.
     * @throws An {@link AuthConfigurationError} if the selected key is missing or invalid.
     */
    private async resolveStoredServiceAccount(name?: string): Promise<AuthOptions> {
        if (!name) {
            this.logger.log("Secret auth selected but no name provided.");
            throw new AuthConfigurationError("The selected Service Account is missing its stored name. Select an authentication method to continue.");
        }
        const secret = await this.context.secrets.get(SECRETS_PREFIX + name);
        if (!secret) {
            this.logger.log(`Secret '${name}' not found in storage.`);
            throw new AuthConfigurationError(`Stored Service Account '${name}' is unavailable. Select an authentication method to continue.`);
        }

        try {
            const credentials = parseServiceAccount(secret);
            this.logger.log(`Using Service Account secret: ${name}`);
            return { credentials, projectId: credentials.project_id };
        } catch {
            this.logger.log(`Stored Service Account '${name}' is invalid.`);
            throw new AuthConfigurationError(`Stored Service Account '${name}' is invalid. Re-import or remove it before continuing.`);
        }
    }

    /**
     * Reads a legacy or environment credential file without blocking the extension host.
     *
     * @remarks
     * Service Account secrets require stricter validation through {@link parseServiceAccount}.
     * Files preserve other Google auth formats, including authorized-user and external accounts.
     *
     * @param filePath - Credential file to read.
     * @returns Parsed credential options, or `undefined` if the file is unavailable or invalid.
     */
    private async resolveFromFile(filePath: string): Promise<AuthOptions | undefined> {
        try {
            const credentials = parseCredentialJson(await readFile(filePath, "utf8"));
            const options: AuthOptions = { keyFilename: filePath, credentials };
            if (typeof credentials.project_id === "string") {
                options.projectId = credentials.project_id;
            }
            return options;
        } catch {
            this.logger.log("Could not read or parse the credential file.");
            return undefined;
        }
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
        const name = enteredName?.trim();
        if (!name) {
            return false;
        }

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

    /** Selects ADC for this workspace and invalidates cached identity data. */
    private async activateAdc(): Promise<void> {
        await this.context.workspaceState.update(WORKSPACE_AUTH_METHOD_KEY, { type: "adc" });
        this.notifyAuthUpdated();
    }
}
