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
 * Only a successful login in this terminal invokes the callback. Completion,
 * terminal closure, and terminal setup failure release the event subscriptions.
 * Without shell integration, the user must refresh models manually.
 *
 * @param projectId - Optional project ID passed to gcloud.
 * @param onSuccess - Activates credentials and refreshes models after a successful command.
 * @param logger - Receives callback failures without exposing terminal output.
 * @param mode - Selects between direct ADC login (`adc`) and personal CLI login (`proxy`).
 */
export function openGcloudLoginTerminal(projectId: string, onSuccess: () => Promise<void>, logger: Pick<Logger, "log">, mode: GcloudLoginMode = "adc"): void {
    const terminal = vscode.window.createTerminal({ name: "Vertex AI: Authentication", iconPath: new vscode.ThemeIcon("key") });
    const baseCommand = LOGIN_COMMANDS[mode];
    const command = createLoginCommand(projectId, baseCommand);
    let completed = false;
    const cleanup = () => {
        completed = true;
        endListener.dispose();
        closeListener.dispose();
    };
    const endListener = vscode.window.onDidEndTerminalShellExecution((event) => {
        if (event.terminal !== terminal || completed || !event.execution.commandLine.value.includes(baseCommand)) {
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
 * @param projectId - Project ID to include when non-empty.
 * @param baseCommand - Base gcloud login command for the active mode.
 * @returns The gcloud login command with quiet mode enabled.
 */
function createLoginCommand(projectId: string, baseCommand: string): string {
    const args: string[] = [];
    if (projectId) {
        args.push("--project", quoteShellArgument(projectId));
    }
    args.push("--quiet");
    return [
        baseCommand,
        ...args,
    ].join(" ");
}

/**
 * Formats a terminal argument using the existing POSIX-compatible quoting convention.
 *
 * @param value - Argument to quote when it contains shell metacharacters.
 * @returns The original safe value, or a single-quoted form with embedded quotes escaped.
 */
function quoteShellArgument(value: string): string {
    if (/^[A-Za-z0-9._:/=-]+$/.test(value)) {
        return value;
    }
    return "'" + value.replace(/'/g, "'\\''") + "'";
}
