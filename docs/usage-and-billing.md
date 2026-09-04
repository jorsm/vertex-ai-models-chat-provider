# docs/usage-and-billing.md

> **Overview**
> This module provides a visual dashboard for tracking LLM usage, token consumption, and estimated costs within the Vertex AI extension.

## Table of Contents
- [Table of Contents](#table-of-contents)
- [Core Concepts](#core-concepts)
- [Request labels and Cloud Billing](#request-labels-and-cloud-billing)
- [API Reference](#api-reference)
  - [DashboardWebview](#dashboardwebview)
  - [CostStatusBar](#coststatusbar)
  - [UsageTrackerService](#usagetrackerservice)
  - [Data Structures](#data-structures)
- [Examples](#examples)

---

## Core Concepts
The usage and billing module is centered around the `DashboardWebview`, which provides an interactive UI for developers to monitor their GCP Vertex AI consumption.

- **Data Visualization**: Uses [ECharts](https://echarts.apache.org/en/index.html) to render time-series costs, token distribution, and payload footprints (input vs. output vs. cached tokens).
- **Cost Estimation**: Calculates estimates from pricing in the active model catalog. Users are warned that the Google Cloud Billing Console remains the final source of truth.
- **Project Context**: Automatically generates deep links to the specific Google Cloud Billing page using the configured `vertexAiChat.projectId`.
- **Real-time Status**: A status bar item provides immediate feedback on today's accumulated costs and the active authentication identity, updating automatically as interactions occur.
- **Filtering**: Supports date range selection, model-specific filtering via a dedicated dropdown, and quick presets (Today, Last 7 Days, This Month, All Time).
- **Persistence**: Usage logs are tracked by the `UsageTrackerService`, which stores daily logs in `.jsonl` format within a `usage_logs` subdirectory of the extension's global storage. The dashboard can permanently dismiss cost warnings by updating the `vertexAiChat.hideBillingWarning` global configuration.

## Request labels and Cloud Billing

The local dashboard is a per-machine estimate. For centralized, invoice-oriented reporting, enable Google Cloud Billing export to BigQuery and use request labels. The extension can attach `vscode-vertex-ai-user` and `vscode-vertex-ai-project` to Gemini and Anthropic Claude requests; MaaS does not currently send billing labels.

Set either a custom `userLabelValue` or `projectLabelValue` when you need stable report dimensions. If an enabled label cannot resolve to either a custom value or its automatic fallback, the request proceeds without that one label and the extension emits a single VS Code warning plus an output-channel warning. This prevents silent loss of an opted-in attribution dimension.

Google only forwards request labels to Cloud Billing for PayGo usage; Provisioned Throughput does not receive them. Use low-cardinality, non-sensitive values: label values surface in billing exports, and Google can omit a label key after too many distinct values. See [Google's request-label documentation](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/capabilities/add-labels-to-api-calls), [billing export setup](https://docs.cloud.google.com/billing/docs/how-to/export-data-bigquery), and the [standard usage export schema](https://docs.cloud.google.com/billing/docs/how-to/export-data-bigquery-tables/standard-usage).

## API Reference

### DashboardWebview
[source](../src/DashboardWebview.ts)
The primary class responsible for creating and managing the VS Code Webview panel for the "Vertex AI Usage & Costs" dashboard.

#### currentPanel
[source](../src/DashboardWebview.ts)
`public static currentPanel: DashboardWebview | undefined`
A static reference to the currently active dashboard instance, used to prevent duplicate panels.

#### createOrShow
[source](../src/DashboardWebview.ts)
`public static createOrShow(extensionUri: vscode.Uri, usageTracker: UsageTrackerService)`
Reveals the existing dashboard panel or creates a new one if it doesn't exist.
- `extensionUri`: The base URI of the extension for resolving local media resources (scripts, CSS).
- `usageTracker`: An instance of `UsageTrackerService` used to query the local usage database.

#### dispose
[source](../src/DashboardWebview.ts)
`public dispose()`
Cleans up the webview panel and disposes of all internal event listeners and subscriptions.

### CostStatusBar
[source](../src/CostStatusBar.ts)
Manages a persistent status bar item that displays today's total estimated cost and the active authentication identity. It updates in real-time as usage is recorded or authentication methods change, using dynamic icons to reflect the active auth type:
- **$(key)**: Encrypted Service Account secret.
- **$(file)**: Legacy linked Service Account file retained for existing workspace configurations. New file selections are imported as encrypted secrets.
- **$(cloud)**: Google Application Default Credentials (ADC).
- **$(pulse)**: Default or disconnected state.

#### constructor
[source](../src/CostStatusBar.ts)
`constructor(usageTracker: UsageTrackerService, authManager: AuthManager, catalogResolver: ModelCatalogResolver)`
Initializes the status bar item at the right side of the status bar (priority 100) and binds it to the dashboard display command. It subscribes to usage and authentication updates to refresh the UI automatically, presenting a rich Markdown tooltip that includes the current GCP project ID, active authentication method, and account identity.
- `usageTracker`: An instance of `UsageTrackerService` used to retrieve daily cost totals.
- `authManager`: An instance of `AuthManager` used to identify the current user or service account.
- `catalogResolver`: The resolver used to show the active model catalog source in the status-bar tooltip.

#### dispose
[source](../src/CostStatusBar.ts)
`public dispose()`
Cleans up the status bar item and disposes of all internal event subscriptions.

### UsageTrackerService
[source](../src/UsageTrackerService.ts)
A backend service dedicated to persisting token usage and calculating costs for every LLM interaction. It manages local JSONL files in the `usage_logs` subdirectory within the extension's global storage.

#### constructor
[source](../src/UsageTrackerService.ts)
`constructor(context: vscode.ExtensionContext, catalogResolver: ModelCatalogResolver)`
Initializes the service and determines the native file system path for usage logging.
- `context`: The VS Code extension context, used to locate the `globalStorageUri` for log persistence.
- `catalogResolver`: The resolver used to calculate costs from the active model catalog.

#### onUsageUpdated
[source](../src/UsageTrackerService.ts)
`public readonly onUsageUpdated: vscode.Event<void>`
An event that fires whenever a new usage entry is successfully recorded, allowing the UI to refresh in real-time.

#### calculateCost
[source](../src/UsageTrackerService.ts)
`public async calculateCost(model: string, tokens: Required<TokenUsage>): Promise<number>`
Calculates the total cost for a specific request by mapping the model ID to its pricing definitions in the active model catalog.
- `model`: The model identifier (e.g., `claude-sonnet-5`).
- `tokens`: A breakdown including input, output, cache_read, and cache_create counts.

#### recordUsage
[source](../src/UsageTrackerService.ts)
`public async recordUsage(model: string, usage: TokenUsage): Promise<void>`
Records a single usage entry. It calculates the cost, standardizes the payload (including characters for system, user text, assistant text, images, tool use, and tool results), and appends it to a daily log file (`YYYYMMDD.jsonl`).

#### getUsageForDate
[source](../src/UsageTrackerService.ts)
`public async getUsageForDate(dateStr: string): Promise<UsageLogEntry[]>`
Retrieves all logs for a specific date provided in `YYYYMMDD` format.

#### getUsageInRange
[source](../src/UsageTrackerService.ts)
`public async getUsageInRange(startDate: Date, endDate: Date): Promise<UsageLogEntry[]>`
Scans the storage directory for files falling within the specified date range and returns a flattened array of entries, ensuring the coverage of the full end date in local time.

#### getTodayTotalCost
[source](../src/UsageTrackerService.ts)
`public async getTodayTotalCost(): Promise<number>`
A convenience method to calculate the cumulative cost of all interactions recorded today in local time.

#### getMinDateFromLogs
[source](../src/UsageTrackerService.ts)
`public async getMinDateFromLogs(): Promise<string | null>`
Identifies the earliest date for which usage logs exist. Returns a string in `YYYY-MM-DD` format or `null` if no logs are found.

### Data Structures
[source](../src/UsageTrackerService.ts)
Definitions of the internal types used for usage logging and cost calculation.

#### UsageLogEntry
[source](../src/UsageTrackerService.ts)
A single log record stored in the daily `.jsonl` files.
- `timestamp`: ISO-8601 UTC timestamp.
- `model`: Model ID.
- `tokens`: A `Required<TokenUsage>` object.
- `cost`: Total calculated cost for this entry.

#### TokenUsage
[source](../src/UsageTrackerService.ts)
Represents the token consumption for a request.
- `input`: Standard input tokens.
- `output`: Generated output tokens.
- `cache_read`: (Optional) Count of tokens served from cache.
- `cache_create`: (Optional) Count of tokens used to populate a cache.
- `characters`: (Optional) A `PayloadCharacters` breakdown.

#### PayloadCharacters
[source](../src/UsageTrackerService.ts)
Detailed character counts used to analyze payload footprints:
- `system`: System instructions characters.
- `user_text`: User input text characters.
- `assistant_text`: Model response text characters.
- `image`: Image related character or pixel equivalents.
- `tool_use`: Characters in tool call definitions.
- `tool_result`: Characters in tool execution results.

## Examples

### Programmatic Dashboard Launch
To show the dashboard from an extension command:
```typescript
import { DashboardWebview } from './DashboardWebview';

// Inside an activation or command registration
DashboardWebview.createOrShow(context.extensionUri, usageTrackerInstance);
```

### Initializing the Cost Status Bar
The status bar should be initialized during extension activation:
```typescript
import { CostStatusBar } from './CostStatusBar';

// Inside activation
const statusBar = new CostStatusBar(usageTracker, authManager, catalogResolver);
context.subscriptions.push(statusBar);
```

### Dashboard UI Components
The dashboard renders several key metrics and interactive elements:
- **Control Bar**: Includes quick date presets (Today, Last 7 Days, This Month, All Time), a **Model Selection** dropdown to filter metrics, and deep links to the Google Cloud Billing Console.
- **Summary Cards**: Displays Total Cost, Total Tokens, Most Used Model, and Cached Tokens.
- **Interactive Charts**:
    - **Costs**: Daily bar chart and model distribution pie chart.
    - **Tokens**: Input vs. Output trends including cache hits.
    - **Payload Footprint**: Analysis of payload density (System, User, Assistant, Images, Tools) across models.
- **Summary Table**: Detailed breakdown of Model, Total Cost, Input Tokens, Output Tokens, Cached Tokens, and Request counts.
