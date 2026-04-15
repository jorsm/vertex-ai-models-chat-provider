import * as vscode from "vscode";

export interface RetryLogEntry {
  attempt: number;
  delayMs: number;
  error: string;
  timestamp: string;
}

export interface RetryOptions {
  /** Maximum number of retries before giving up (default: 3) */
  maxRetries?: number;
  /** Base delay in milliseconds for exponential backoff (default: 2000) */
  baseDelayMs?: number;
  /** Maximum delay in milliseconds between retries (default: 20000) */
  maxDelayMs?: number;
  /** Optional logger function to output messages */
  log?: (msg: string) => void;
  /** Cancellation token to abort the retry loop early */
  token?: vscode.CancellationToken;
}

/**
 * Executes an async operation with automatic exponential backoff retries.
 * Designed to handle rate limits (429) and temporary service unavailabilities (503).
 *
 * @param operation The async function to execute.
 * @param options Configuration for the retry behavior.
 * @returns The result of the operation if successful.
 */
export async function withRetry<T>(operation: () => Promise<T>, options?: RetryOptions): Promise<T> {
  const maxRetries = options?.maxRetries ?? 5;
  const baseDelayMs = options?.baseDelayMs ?? 2000;
  const maxDelayMs = options?.maxDelayMs ?? 20000;

  let attempt = 0;
  const retryLog: RetryLogEntry[] = [];

  while (true) {
    if (options?.token?.isCancellationRequested) {
      throw new Error("Cancelled by user");
    }

    try {
      const result = await operation();

      // If we had previous retries that eventually succeeded, log the summary
      if (attempt > 0 && options?.log) {
        options.log(`✅ Operation succeeded after ${attempt} retries.`);
        options.log(`   Retry history: ${JSON.stringify(retryLog, null, 2)}`);
      }

      return result;
    } catch (e: any) {
      const isRetryable = isRetryableError(e);

      if (!isRetryable || attempt >= maxRetries) {
        // If we fail after some retries, we can optionally log the history
        if (attempt > 0 && options?.log) {
          options.log(`❌ Operation failed after ${attempt} retries. Final error: ${e.message || e}`);
          options.log(`   Retry history: ${JSON.stringify(retryLog, null, 2)}`);
        }
        throw e;
      }

      attempt++;

      // Exponential backoff: baseDelay * 2^(attempt-1), capped at maxDelayMs
      // Adding jitter (random 0-1000ms) to prevent thundering herd problem
      const delayMs = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1)) + Math.random() * 1000;
      const errorMsg = e.message || e.toString();

      // Keep a structured log of this retry attempt
      retryLog.push({
        attempt,
        delayMs: Math.round(delayMs),
        error: errorMsg,
        timestamp: new Date().toISOString(),
      });

      if (options?.log) {
        options.log(`⚠️ Retryable error encountered: "${errorMsg}". Retrying in ${Math.round(delayMs)}ms (attempt ${attempt}/${maxRetries})...`);
      }

      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

/**
 * Determines if an error is transient and should trigger a retry.
 * Matches common rate limiting (429) and server overload (502/503) patterns.
 */
export function isRetryableError(e: any): boolean {
  if (!e) {
    return false;
  }

  const msg = (e.message || e.toString()).toLowerCase();

  // 429 Too Many Requests / Resource Exhausted
  if (msg.includes("429") || msg.includes("too many requests") || msg.includes("resource_exhausted") || msg.includes("resource exhausted") || msg.includes("quota")) {
    return true;
  }

  // 503 Service Unavailable
  if (msg.includes("503") || msg.includes("service unavailable") || msg.includes("overloaded") || msg.includes("502") || msg.includes("bad gateway")) {
    return true;
  }

  // Check HTTP status codes
  if (e.status === 429 || e.status === 503 || e.status === 502 || e.status === "RESOURCE_EXHAUSTED" || e.code === 429 || e.code === 503 || e.code === 502) {
    return true;
  }

  return false;
}
