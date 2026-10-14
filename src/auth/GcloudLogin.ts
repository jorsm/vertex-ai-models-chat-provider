import * as vscode from "vscode";
import type { Logger } from "../utils/Logger";

export type GcloudLoginMode = "adc" | "proxy";

const LOGIN_COMMANDS: Record<GcloudLoginMode, string> = {
    adc: "gcloud auth application-default login",
    proxy: "gcloud auth login",
};

/**
 * Opens a terminal for gcloud login and observes its completion through shell integration.
 *
 * @remarks
 * Only the complete submitted login command in this terminal can invoke the
 * callback. When its start event is available, completion must also belong to
 * that same execution. Completion, closure, and setup failure release all listeners.
 * Without shell integration, the user must refresh models manually.
 *
 * @param projectId - Optional project ID passed to gcloud.
 * @param onSuccess - Activates credentials and refreshes models after a successful command.
 * @param logger - Receives callback failures without exposing terminal output.
 * @param mode - Selects between direct ADC login (`adc`) and personal CLI login (`proxy`).
 */
export function openGcloudLoginTerminal(projectId: string, onSuccess: () => Promise<void>, logger: Pick<Logger, "log">, mode: GcloudLoginMode = "adc"): void {
    const terminal = vscode.window.createTerminal({ name: "Vertex AI: Authentication", iconPath: new vscode.ThemeIcon("key") });
    const command = createLoginCommand(projectId, LOGIN_COMMANDS[mode]);
    let loginExecution: vscode.TerminalShellExecution | undefined;
    let completed = false;
    const cleanup = () => {
        completed = true;
        startListener.dispose();
        endListener.dispose();
        closeListener.dispose();
    };
    const startListener = vscode.window.onDidStartTerminalShellExecution((event) => {
        if (event.terminal !== terminal || completed || loginExecution) {
            return;
        }
        if (event.execution.commandLine.value.trim() === command) {
            loginExecution = event.execution;
        }
    });
    const endListener = vscode.window.onDidEndTerminalShellExecution((event) => {
        if (event.terminal !== terminal || completed || event.execution.commandLine.value.trim() !== command) {
            return;
        }
        if (loginExecution && event.execution !== loginExecution) {
            return;
        }
        cleanup();
        if (event.exitCode !== 0) {
            const exitCodeNotice = event.exitCode === undefined ? "" : ` with exit code ${event.exitCode}`;
            void vscode.window.showErrorMessage(`Vertex AI: gcloud authentication failed${exitCodeNotice}. Review the authentication terminal for details.`);
            return;
        }
        void onSuccess().catch(() => logger.log("Post-authentication activation or refresh failed."));
    });
    const closeListener = vscode.window.onDidCloseTerminal((closedTerminal) => {
        if (closedTerminal === terminal) {
            cleanup();
        }
    });

    try {
        terminal.show();
        terminal.sendText(command);
    } catch (error) {
        cleanup();
        throw error;
    }
    void vscode.window.showInformationMessage("Vertex AI: Complete gcloud authentication in the terminal. Models will refresh automatically when shell integration reports success; otherwise run Refresh Models.");
}

/**
 * Builds the terminal command using only the fixed login arguments and a quoted project ID.
 *
 * @remarks
 * Preserves the existing POSIX-compatible quoting for project IDs with shell metacharacters.
 *
 * @param projectId - Project ID to include when non-empty.
 * @param baseCommand - Base gcloud login command for the active mode.
 * @returns The gcloud login command with quiet mode enabled.
 */
function createLoginCommand(projectId: string, baseCommand: string): string {
    const args: string[] = [];
    if (projectId) {
        let quotedProjectId = projectId;
        if (!/^[A-Za-z0-9._:/=-]+$/.test(projectId)) {
            quotedProjectId = "'" + projectId.replace(/'/g, "'\\''") + "'";
        }
        args.push("--project", quotedProjectId);
    }
    args.push("--quiet");
    return [
        baseCommand,
        ...args,
    ].join(" ");
}
