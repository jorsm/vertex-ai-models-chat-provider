import * as vscode from "vscode";
import { AuthManager } from "./AuthManager";
import { UsageTrackerService } from "./UsageTrackerService";
import { Logger } from "./utils/Logger";

export class CostStatusBar implements vscode.Disposable {
  private readonly statusBarItem: vscode.StatusBarItem;
  private readonly usageTracker: UsageTrackerService;
  private readonly authManager: AuthManager;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly logger = new Logger("CostStatusBar");

  constructor(usageTracker: UsageTrackerService, authManager: AuthManager) {
    this.usageTracker = usageTracker;
    this.authManager = authManager;

    // Create the status bar item aligned to the right (priority 100 to stick near the edge)
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.statusBarItem.command = "claudeBilling.showDashboard";
    this.statusBarItem.tooltip = "Click to open Usage Dashboard";

    // Listen to usage updates
    this.disposables.push(
      this.usageTracker.onUsageUpdated(() => {
        this.updateStatusBar().catch((err) => this.logger.log(`Error updating status bar on usage update: ${err}`));
      }),
    );

    // Listen to auth updates
    this.disposables.push(
      this.authManager.onAuthUpdated(() => {
        this.updateStatusBar().catch((err) => this.logger.log(`Error updating status bar on auth update: ${err}`));
      }),
    );

    // Initial update
    this.updateStatusBar().catch((err) => this.logger.log(`Error updating status bar on initialization: ${err}`));
    this.statusBarItem.show();
  }

  private async updateStatusBar(): Promise<void> {
    try {
      const todayCost = await this.usageTracker.getTodayTotalCost();
      const identity = await this.authManager.getIdentity();
      const activeMethod = this.authManager.getActiveMethod();
      const config = vscode.workspace.getConfiguration("vertexAiChat");

      // Inspect to see where the project ID is coming from
      const inspection = config.inspect<string>("projectId");
      const projectId = config.get<string>("projectId") || "";

      let projectSource = "Unset";
      if (inspection?.workspaceValue) {
        projectSource = "Workspace Setting";
      } else if (inspection?.globalValue) {
        projectSource = "Global (User) Setting";
      } else if (inspection?.defaultValue) {
        projectSource = "Default";
      }

      // Determine icon based on auth type
      let icon = "$(pulse)"; // Default
      let methodDesc = "Default (ADC)";

      if (activeMethod) {
        if (activeMethod.type === "secret") {
          icon = "$(key)";
          methodDesc = `Secret: ${activeMethod.value}`;
        } else if (activeMethod.type === "file") {
          icon = "$(file)";
          methodDesc = "Local JSON File";
        } else if (activeMethod.type === "adc") {
          icon = "$(cloud)";
          methodDesc = "gcloud ADC";
        }
      }

      // Format to 2 decimal places with $
      const formattedCost = `$${todayCost.toFixed(2)}`;
      this.statusBarItem.text = `${icon} Today: ${formattedCost}`;

      const identityText = identity ? `**Account:** ${identity}` : "**Account:** Not signed in (using ADC)";

      const tooltip = new vscode.MarkdownString();
      tooltip.appendMarkdown(`### Vertex AI Usage\n\n`);
      tooltip.appendMarkdown(`**Today's Cost:** ${formattedCost}\n\n`);
      tooltip.appendMarkdown(`---\n\n`);
      tooltip.appendMarkdown(`**Project:** \`${projectId || "(Unset)"}\`\n`);
      tooltip.appendMarkdown(`*Source: ${projectSource}*\n\n`);
      tooltip.appendMarkdown(`**Auth Method:** ${methodDesc}\n\n`);
      tooltip.appendMarkdown(`${identityText}\n\n`);
      tooltip.appendMarkdown(`---\n\n`);
      tooltip.appendMarkdown(`$(dashboard) Click to open Dashboard`);

      this.statusBarItem.tooltip = tooltip;
    } catch (error) {
      this.logger.log(`Error updating status bar: ${error}`);
      this.statusBarItem.text = `$(pulse) Today: $--.--`;
      this.statusBarItem.tooltip = "Click to open Usage Dashboard";
    }
  }

  public dispose(): void {
    this.statusBarItem.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}
