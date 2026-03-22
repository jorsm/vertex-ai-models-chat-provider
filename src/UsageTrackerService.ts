import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import * as modelsFile from "./models.json";

export interface PayloadCharacters {
  system: number;
  user_text: number;
  assistant_text: number;
  image: number;
  tool_use: number;
  tool_result: number;
}

export interface TokenUsage {
  input: number;
  output: number;
  cache_read?: number;
  cache_create?: number;
  characters?: PayloadCharacters;
}

export interface UsageLogEntry {
  timestamp: string;
  model: string;
  tokens: Required<TokenUsage>;
  cost: number;
}

export class UsageTrackerService {
  private readonly _onUsageUpdated = new vscode.EventEmitter<void>();
  public readonly onUsageUpdated = this._onUsageUpdated.event;

  private readonly storageDir: string;

  constructor(context: vscode.ExtensionContext) {
    // We use globalStorageUri.fsPath to get the native file system path
    this.storageDir = path.join(context.globalStorageUri.fsPath, "usage_logs");
  }

  /**
   * Calculates the total cost for a given request
   * @param model The model ID
   * @param tokens The fully populated token breakdown
   * @returns The total cost calculated based on the pricing map
   */
  public calculateCost(model: string, tokens: Required<TokenUsage>): number {
    // Retrieve the model from models.json
    const modelDef = modelsFile.candidateModels.find((m: any) => m.id === model);
    const pricing = modelDef?.pricing;

    if (!pricing) {
      // Default to 0 or fallback pricing if the model is not found in the map
      return 0;
    }

    const inputCost = (tokens.input / 1_000_000) * pricing.input;
    const outputCost = (tokens.output / 1_000_000) * pricing.output;
    const cacheReadCost = (tokens.cache_read / 1_000_000) * pricing.cache_read;
    const cacheCreateCost = (tokens.cache_create / 1_000_000) * pricing.cache_create;

    return inputCost + outputCost + cacheReadCost + cacheCreateCost;
  }

  /**
   * Records the usage entry by appending it to the YYYYMMDD.jsonl file
   * @param model The model ID used
   * @param usage The raw token usage object
   */
  public async recordUsage(model: string, usage: TokenUsage): Promise<void> {
    const date = new Date();

    // Format YYYYMMDD using Local Time
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const fileName = `${year}${month}${day}.jsonl`;

    const filePath = path.join(this.storageDir, fileName);

    // Normalize token usages, handling optional caching values
    const tokens: Required<TokenUsage> = {
      input: usage.input || 0,
      output: usage.output || 0,
      cache_read: usage.cache_read || 0,
      cache_create: usage.cache_create || 0,
      characters: usage.characters || { system: 0, user_text: 0, assistant_text: 0, image: 0, tool_use: 0, tool_result: 0 },
    };

    const cost = this.calculateCost(model, tokens);

    const logEntry: UsageLogEntry = {
      timestamp: date.toISOString(), // Standardizing on ISO-8601 UTC
      model,
      tokens,
      cost,
    };

    // Serialize single line format
    const logString = JSON.stringify(logEntry) + "\n";

    try {
      await this.ensureStorageDirExists();
      // Using standard Node fs.promises is much more efficient and practical
      // for append-only log files than loading/saving via vscode.workspace.fs
      await fs.appendFile(filePath, logString, "utf8");

      // Emit the event to inform other parts of the extension (e.g. Status Bar)
      this._onUsageUpdated.fire();
    } catch (error) {
      console.error("[UsageTrackerService] Failed to record usage:", error);
      // Fails safe – missing usage stats shouldn't crash the entire chat provider
    }
  }

  /**
   * Reads all log entries for the given UTC date. Format of date parameter: YYYYMMDD
   */
  public async getUsageForDate(dateStr: string): Promise<UsageLogEntry[]> {
    const filePath = path.join(this.storageDir, `${dateStr}.jsonl`);
    try {
      const content = await fs.readFile(filePath, "utf8");
      const lines = content.split("\n").filter((line) => line.trim().length > 0);
      return lines
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean) as UsageLogEntry[];
    } catch (error) {
      // File might not exist yet if no usage for today
      return [];
    }
  }

  /**
   * Scans logs across a daily range and returns all entries.
   */
  public async getUsageInRange(startDate: Date, endDate: Date): Promise<UsageLogEntry[]> {
    const startStr = `${startDate.getFullYear()}${String(startDate.getMonth() + 1).padStart(2, "0")}${String(startDate.getDate()).padStart(2, "0")}`;
    const endStr = `${endDate.getFullYear()}${String(endDate.getMonth() + 1).padStart(2, "0")}${String(endDate.getDate()).padStart(2, "0")}`;

    // Ensure the end date covers the very end of the day in Local Time
    const inclusiveEndDate = new Date(endDate);
    inclusiveEndDate.setHours(23, 59, 59, 999);

    try {
      const files = await fs.readdir(this.storageDir);
      const targetFiles = files.filter((f) => {
        if (!f.endsWith(".jsonl")) {
          return false;
        }
        const d = f.replace(".jsonl", "");
        return d >= startStr && d <= endStr;
      });

      const allLogs: UsageLogEntry[] = [];
      for (const file of targetFiles) {
        const content = await fs.readFile(path.join(this.storageDir, file), "utf8");
        const lines = content.split("\n").filter((l) => l.trim().length > 0);
        for (const line of lines) {
          try {
            const obj = JSON.parse(line);
            // Ensure it fits date range fully just in case the file timestamp isn't perfectly mapped
            const logDate = new Date(obj.timestamp);
            if (logDate >= startDate && logDate <= inclusiveEndDate) {
              allLogs.push(obj);
            }
          } catch {}
        }
      }
      return allLogs;
    } catch (error) {
      return [];
    }
  }

  /**
   * Retrieves today's total cost in UTC
   */
  public async getTodayTotalCost(): Promise<number> {
    const date = new Date();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const dateStr = `${year}${month}${day}`;

    const logs = await this.getUsageForDate(dateStr);
    return logs.reduce((total, log) => total + log.cost, 0);
  }

  /**
   * Retrieves the minimum (earliest) date from available log files.
   * Returns a YYYY-MM-DD formatted string, or null if no logs exist.
   */
  public async getMinDateFromLogs(): Promise<string | null> {
    try {
      const files = await fs.readdir(this.storageDir);
      const logFiles = files.filter((f) => f.endsWith(".jsonl"));

      if (logFiles.length === 0) {
        return null;
      }

      // Extract dates and sort them (YYYYMMDD format naturally sorts correctly)
      const dates = logFiles
        .map((f) => f.replace(".jsonl", ""))
        .filter((d) => /^\d{8}$/.test(d))
        .sort();

      if (dates.length === 0) {
        return null;
      }

      const minDate = dates[0];
      const year = minDate.substring(0, 4);
      const month = minDate.substring(4, 6);
      const day = minDate.substring(6, 8);

      return `${year}-${month}-${day}`;
    } catch (error) {
      return null;
    }
  }

  /**
   * Ensures the usage_logs directory exists before attempting to write to it
   */
  private async ensureStorageDirExists(): Promise<void> {
    try {
      await fs.access(this.storageDir);
    } catch {
      await fs.mkdir(this.storageDir, { recursive: true });
    }
  }
}
