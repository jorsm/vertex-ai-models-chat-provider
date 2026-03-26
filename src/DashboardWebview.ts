import * as vscode from "vscode";

import { UsageTrackerService } from "./UsageTrackerService";

export class DashboardWebview {
  public static currentPanel: DashboardWebview | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private readonly _usageTracker: UsageTrackerService;
  private readonly _disposables: vscode.Disposable[] = [];

  public static createOrShow(extensionUri: vscode.Uri, usageTracker: UsageTrackerService) {
    const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;

    if (DashboardWebview.currentPanel) {
      DashboardWebview.currentPanel._panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel("claudeBillingDashboard", "Vertex AI Usage & Costs", column || vscode.ViewColumn.One, {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
    });

    DashboardWebview.currentPanel = new DashboardWebview(panel, extensionUri, usageTracker);
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, usageTracker: UsageTrackerService) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._usageTracker = usageTracker;

    this._update();

    // Listeners for cleanup
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    // Receive messages from the Webview UI
    this._panel.webview.onDidReceiveMessage(
      (message) => {
        if (message.command === "fetchData") {
          this._fetchData(message.startDate, message.endDate).catch((err) => console.error(err));
          return;
        }
        if (message.command === "getMinDate") {
          this._sendMinDate().catch((err) => console.error(err));
          return;
        }
        if (message.command === "dismissWarning") {
          console.log("[VertexAnthropic] Received dismissWarning command from Dashboard.");
          vscode.workspace
            .getConfiguration("vertexAnthropic")
            .update("hideBillingWarning", true, vscode.ConfigurationTarget.Global)
            .then(
              () => console.log("[VertexAnthropic] hideBillingWarning saved securely to global settings."),
              (err) => console.error("[VertexAnthropic] Error saving global settings:", err),
            );
          return;
        }
      },
      null,
      this._disposables,
    );

    // Notify Webview to refresh if new usage happens while dashboard is open
    this._usageTracker.onUsageUpdated(() => {
      this._panel.webview.postMessage({ type: "UPDATE_SIGNAL" });
    });
  }

  private async _fetchData(startDateStr: string, endDateStr: string) {
    // e.g. "2026-03-20" -> parse to local midnight explicitly
    const [sy, sm, sd] = startDateStr.split("-").map(Number);
    const start = new Date(sy, sm - 1, sd, 0, 0, 0, 0);

    const [ey, em, ed] = endDateStr.split("-").map(Number);
    const end = new Date(ey, em - 1, ed, 0, 0, 0, 0);

    const logs = await this._usageTracker.getUsageInRange(start, end);
    this._panel.webview.postMessage({ type: "RENDER_DATA", payload: logs });
  }

  private async _sendMinDate() {
    const minDate = await this._usageTracker.getMinDateFromLogs();
    this._panel.webview.postMessage({ type: "MIN_DATE", payload: minDate });
  }

  public dispose() {
    DashboardWebview.currentPanel = undefined;
    this._panel.dispose();
    while (this._disposables.length) {
      const x = this._disposables.pop();
      if (x) {
        x.dispose();
      }
    }
  }

  private _update() {
    this._panel.webview.html = this._getHtmlForWebview(this._panel.webview);
  }

  private _getHtmlForWebview(webview: vscode.Webview) {
    // Compute URIs to load scripts/styles from 'media' directory
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, "media", "dashboard.js"));
    const echartsUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, "media", "echarts.min.js"));
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, "media", "dashboard.css"));

    const projectId = vscode.workspace.getConfiguration("vertexAnthropic").get<string>("projectId", "UNKNOWN_PROJECT");
    const billingUrl = `https://console.cloud.google.com/billing?project=${projectId}`;
    const hideWarning = vscode.workspace.getConfiguration("vertexAnthropic").get<boolean>("hideBillingWarning", false);

    const nonce = getNonce();

    return `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <!-- Limit scripts execution to our webview with nonces -->
                <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Vertex AI Usage</title>
                <link href="${cssUri}" rel="stylesheet">
                <script src="${echartsUri}"></script>
            </head>
            <body>
                ${
                  hideWarning
                    ? ""
                    : `
                <div id="billing-warning" class="billing-warning">
                    <div class="warning-icon">⚠️</div>
                    <div class="warning-content">
                        <strong style="font-size: 1.25em;">Cost Estimates Only</strong><br>
                        This dashboard provides <em>raw token estimates</em> based on standard publicly documented pricing. <br>
                        <strong>Actual invoiced costs may vary</strong> due to region, specific contract discounts, or automated pricing updates. <br>
                        <em>The final source of truth is the Google Cloud Billing Console.</em><br>
                        <a href="${billingUrl}" target="_blank">Open Google Cloud Billing for ${projectId}</a>
                    </div>
                    <button id="dismiss-warning-btn" class="dismiss-btn" title="Dismiss this alert permanently">✕</button>
                </div>
                `
                }

                <div class="control-bar">
                    <div class="presets">
                        <button id="btn-today">Today</button>
                        <button id="btn-7days">Last 7 Days</button>
                        <button id="btn-month">This Month</button>
                        <button id="btn-all">All Time</button>
                    </div>
                    <a id="billing-btn" href="${billingUrl}" target="_blank" title="Open Google Cloud Billing Console">
                        <span class="btn-icon">☁️</span>
                        <span class="btn-text">Google Cloud Billing</span>
                    </a>
                    <div class="date-range">
                        <label style="margin-right: 15px; font-weight: bold; font-size: 0.9em; opacity: 0.9;">
                             Model: <select id="model-select" class="model-dropdown"><option value="all">All Models</option></select>
                        </label>
                        <input type="date" id="start-date" />
                        <span>to</span>
                        <input type="date" id="end-date" />
                    </div>
                </div>

                <div class="summary-cards">
                    <div class="card">
                        <div class="card-title">Total Cost</div>
                        <div class="card-value" id="val-cost">$0.00</div>
                    </div>
                    <div class="card">
                        <div class="card-title">Total Tokens</div>
                        <div class="card-value" id="val-tokens">0</div>
                    </div>
                    <div class="card">
                        <div class="card-title">Most Used Model</div>
                        <div class="card-value" id="val-model">--</div>
                    </div>
                    <div class="card">
                        <div class="card-title">Cached Tokens</div>
                        <div class="card-value" id="val-savings">0 tkns</div>
                    </div>
                </div>

                <h1 class="section-title">💸 Costs</h1>
                <div class="charts-row">
                    <div class="chart-container" id="cost-chart"></div>
                    <div class="chart-container pie-container" id="cost-pie"></div>
                </div>

                <h1 class="section-title">📊 Tokens</h1>
                <div class="charts-row">
                    <div class="chart-container" id="token-chart"></div>
                    <div class="chart-container pie-container" id="token-pie"></div>
                </div>

                <h1 class="section-title">📦 Payload Footprint</h1>
                <div class="charts-row">
                    <div class="chart-container" id="payload-chart"></div>
                    <div class="chart-container pie-container" id="payload-pie"></div>
                </div>

                <h1 class="section-title">📋 Summary</h1>
                <div class="table-container">
                    <table id="summary-table">
                        <thead>
                            <tr>
                                <th>Model</th>
                                <th>Total Cost</th>
                                <th>Input Tokens</th>
                                <th>Output Tokens</th>
                                <th>Cached Tokens</th>
                                <th>Requests</th>
                            </tr>
                        </thead>
                        <tbody></tbody>
                    </table>
                </div>

                <script nonce="${nonce}" src="${echartsUri}"></script>
                <script nonce="${nonce}" src="${scriptUri}"></script>
            </body>
            </html>`;
  }
}

function getNonce() {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
