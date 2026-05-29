import * as vscode from "vscode";
import { UsageTrackerService } from "./UsageTrackerService";
import { AuthManager } from "./AuthManager";

export class CostStatusBar implements vscode.Disposable {
  private readonly statusBarItem: vscode.StatusBarItem;
  private readonly usageTracker: UsageTrackerService;
  private readonly authManager: AuthManager;
  private readonly disposables: vscode.Disposable[] = [];

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
        this.updateStatusBar().catch((err) => console.error(err));
      }),
    );

    // Listen to auth updates
    this.disposables.push(
      this.authManager.onAuthUpdated(() => {
        this.updateStatusBar().catch((err) => console.error(err));
      }),
    );

    // Initial update
    this.updateStatusBar().catch((err) => console.error(err));
    this.statusBarItem.show();
  }

  private async updateStatusBar(): Promise<void> {
    try {
      const todayCost = await this.usageTracker.getTodayTotalCost();
      const identity = await this.authManager.getIdentity();

      // Format to 2 decimal places with $
      const formattedCost = `$${todayCost.toFixed(2)}`;
      this.statusBarItem.text = `$(pulse) Today: ${formattedCost}`;

      const identityText = identity ? `Account: ${identity}` : "Account: Not signed in (using ADC)";
      this.statusBarItem.tooltip = new vscode.MarkdownString(`**Vertex AI Usage**\n\nToday's Cost: ${formattedCost}\n\n${identityText}\n\nClick to open Dashboard`);
    } catch (error) {
      console.error("[CostStatusBar] Error updating status bar:", error);
      this.statusBarItem.text = `$(pulse) Today: $--.--`;
      this.statusBarItem.tooltip = "Click to open Usage Dashboard";
    }
  }

  public dispose(): void {
    this.statusBarItem.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}
