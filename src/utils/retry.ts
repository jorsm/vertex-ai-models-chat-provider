import * as vscode from "vscode";

export class VertexAuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VertexAuthenticationError";
  }
}

export interface RetryLogEntry {
  attempt: number;
  delayMs: number;
  error: string;
  timestamp: string;
}

export interface RetryOptions {
  /** Maximum number of retries before giving up (default: unlimited when duration-based retry is enabled) */
  maxRetries?: number;
  /** Base delay in milliseconds for exponential backoff (default: 2000) */
  baseDelayMs?: number;
  /** Maximum delay in milliseconds between retries (default: 30000) */
  maxDelayMs?: number;
  /** Optional logger function to output messages */
  log?: (msg: string) => void;
  /** Cancellation token to abort the retry loop early */
  token?: vscode.CancellationToken;
  /** Maximum total retry duration in milliseconds (default from settings or 30 minutes) */
  maxRetryDurationMs?: number;
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
  const maxRetries = options?.maxRetries ?? Number.MAX_SAFE_INTEGER;
  const baseDelayMs = options?.baseDelayMs ?? 2000;
  const maxDelayMs = options?.maxDelayMs ?? 30000;
  const maxRetryDurationMs = options?.maxRetryDurationMs ?? getRetryMaxDurationMsFromSettings();

  let attempt = 0;
  const retryLog: RetryLogEntry[] = [];
  const startTime = Date.now();
  let longRetryNotificationTimer: ReturnType<typeof setTimeout> | undefined;
  let finished = false;

  const cleanupTimer = () => {
    if (longRetryNotificationTimer) {
      clearTimeout(longRetryNotificationTimer);
      longRetryNotificationTimer = undefined;
    }
  };

  longRetryNotificationTimer = setTimeout(() => {
    if (finished || options?.token?.isCancellationRequested) {
      return;
    }

    const elapsedMs = Date.now() - startTime;
    if (elapsedMs >= 60000) {
      const remainingMinutes = Math.max(0, Math.round((maxRetryDurationMs - elapsedMs) / 60000));
      vscode.window.showWarningMessage(
        `Vertex AI Models Chat Provider: la chiamata sta fallendo per un tempo prolungato. L'estensione ha già provato nuovi tentativi per 1 minuto ma il servizio sta ancora dando problemi. Senza toccare nulla continuerà a ritentare per i successivi ${remainingMinutes} minuti (in base alla configurazione). Se vuoi fermare la richiesta, usa il pulsante Stop/Cancel nella chat dell'agente.`,
      );
    }
  }, 60000);

  while (true) {
    if (options?.token?.isCancellationRequested) {
      cleanupTimer();
      throw new Error("Cancelled by user");
    }

    try {
      const result = await operation();
      finished = true;
      cleanupTimer();
      logRetrySummary(true, attempt, retryLog, undefined, options?.log);
      return result;
    } catch (e: any) {
      const elapsedMs = Date.now() - startTime;
      if (!isRetryableError(e) || attempt >= maxRetries || elapsedMs >= maxRetryDurationMs) {
        cleanupTimer();
        logRetrySummary(false, attempt, retryLog, e, options?.log);
        throw e;
      }

      attempt++;
      const delayMs = calculateDelay(attempt, baseDelayMs, maxDelayMs);
      const timeLeftMs = Math.max(0, maxRetryDurationMs - elapsedMs);
      const actualDelayMs = Math.min(delayMs, timeLeftMs);

      if (actualDelayMs <= 0) {
        cleanupTimer();
        logRetrySummary(false, attempt, retryLog, e, options?.log);
        throw e;
      }

      handleRetryAttempt(attempt, maxRetries, actualDelayMs, e, retryLog, options?.log);
      await new Promise((resolve) => setTimeout(resolve, actualDelayMs));
    }
  }
}

function getRetryMaxDurationMsFromSettings(): number {
  const durationMinutes = vscode.workspace.getConfiguration("vertexAiChat").get<number>("retryMaxDurationMinutes", 30);
  return Math.max(1, durationMinutes) * 60_000;
}

function calculateDelay(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  return Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1)) + Math.random() * 1000;
}

function logRetrySummary(success: boolean, attempt: number, retryLog: RetryLogEntry[], error: any, log?: (msg: string) => void) {
  if (attempt === 0 || !log) {
    return;
  }
  const message = success
    ? `✅ Operation succeeded after ${attempt} retries.`
    : `❌ Operation failed after ${attempt} retries. Final error: ${error.message || error}`;
  log(message);
  log(`   Retry history: ${JSON.stringify(retryLog, null, 2)}`);
}

function handleRetryAttempt(attempt: number, maxRetries: number, delayMs: number, e: any, retryLog: RetryLogEntry[], log?: (msg: string) => void) {
  const errorMsg = e.message || e.toString();
  retryLog.push({
    attempt,
    delayMs: Math.round(delayMs),
    error: errorMsg,
    timestamp: new Date().toISOString(),
  });

  if (log) {
    log(`⚠️ Retryable error encountered: "${errorMsg}". Retrying in ${Math.round(delayMs)}ms (attempt ${attempt}/${maxRetries})...`);
  }
}

// Native Node.js / Fetch network error codes that are safe to retry
const NETWORK_ERROR_CODES = new Set([
  "ECONNRESET", // Connection reset by peer
  "ETIMEDOUT", // Operation timeout
  "ECONNREFUSED", // Connection refused (e.g. server down)
  "ENOTFOUND", // DNS lookup failed
  "EAI_AGAIN", // Temporary DNS error
  "UND_ERR_CONNECT_TIMEOUT", // Undici/Node.js fetch specific timeout
]);

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

  // 503 Service Unavailable / 502 Bad Gateway
  if (msg.includes("503") || msg.includes("service unavailable") || msg.includes("overloaded") || msg.includes("502") || msg.includes("bad gateway")) {
    return true;
  }

  // Manage specific error messages that indicate transient issues (e.g. network problems, timeouts)
  if (
    msg.includes("fetch failed") ||
    msg.includes("network error") ||
    msg.includes("socket hang up") ||
    msg.includes("timeout") ||
    msg.includes("sorry, your request failed") // Common message from Google APIs under heavy load
  ) {
    return true;
  }

  // Check HTTP status codes
  if (e.status === 429 || e.status === 503 || e.status === 502 || e.status === "RESOURCE_EXHAUSTED" || e.code === 429 || e.code === 503 || e.code === 502) {
    return true;
  }

  // Check the main error code or the cause (if the error is wrapped)
  if (NETWORK_ERROR_CODES.has(e.code) || (e.cause && NETWORK_ERROR_CODES.has(e.cause.code))) {
    return true;
  }

  return false;
}

/**
 * Checks if an error is authentication-related (e.g. invalid ADC credentials)
 * and if so, throws a user-friendly error instructing them to re-authenticate.
 */
export function checkAuthError(e: any): void {
  if (!e) {
    return;
  }

  const msg = (e.message || e.toString()).toLowerCase();
  if (msg.includes("invalid_grant") || msg.includes("invalid_rapt") || msg.includes("could not load the default credentials") || msg.includes("reauth related error") || e.status === 401 || e.code === 401) {
    throw new VertexAuthenticationError("Google Cloud credentials have expired or are invalid. Please run 'gcloud auth application-default login' in your terminal.");
  }
}
