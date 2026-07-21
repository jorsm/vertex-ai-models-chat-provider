import * as vscode from "vscode";

export class Logger {
  // Shared output channel for all instances
  private static outputChannel: vscode.OutputChannel;
  private context: string;
  private static readonly channelName = "Google Agent Platform for Copilot Chat";

  /**
   * Initializes the shared Output Channel.
   * Call this once in your extension's activate() function.
   */
  public static initialize(): void {
    if (!Logger.outputChannel) {
      Logger.outputChannel = vscode.window.createOutputChannel(this.channelName);
    }
  }

  /**
   * Factory method to get a logger instance (optional alternative to `new Logger()`)
   */
  public static getLogger(context: string): Logger {
    return new Logger(context);
  }

  constructor(context: string) {
    this.context = context;

    // Fallback in case someone forgot to call Logger.initialize()
    if (!Logger.outputChannel) {
      Logger.outputChannel = vscode.window.createOutputChannel(Logger.channelName);
    }
  }

  public log(message: string): void {
    const timestamp = new Date().toISOString();
    const formattedMessage = `[${timestamp}][${this.context}] ${message}`;

    // Append to the VS Code Output tab
    Logger.outputChannel.appendLine(formattedMessage);

    // Also log to the debug console for local development
    console.log(formattedMessage);
  }

  public error(message: string, error: unknown): void {
    this.log(`${message}\n${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  }
}
