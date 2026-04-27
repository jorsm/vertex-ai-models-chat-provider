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

  // 503 Service Unavailable / 502 Bad Gateway
  if (msg.includes("503") || msg.includes("service unavailable") || msg.includes("overloaded") || msg.includes("502") || msg.includes("bad gateway")) {
    return true;
  }

  // 1. GESTIONE ERRORI DI RETE (dal messaggio) e messaggi generici
  if (
    msg.includes("fetch failed") ||
    msg.includes("network error") ||
    msg.includes("socket hang up") ||
    msg.includes("timeout") ||
    msg.includes("sorry, your request failed") // Cattura l'errore specifico che vedi nei log
  ) {
    return true;
  }

  // Check HTTP status codes
  if (e.status === 429 || e.status === 503 || e.status === 502 || e.status === "RESOURCE_EXHAUSTED" || e.code === 429 || e.code === 503 || e.code === 502) {
    return true;
  }

  // 2. GESTIONE ERRORI DI RETE (dai codici di errore nativi di Node.js / Fetch)
  const networkErrorCodes = [
    "ECONNRESET",    // Connessione resettata dal peer
    "ETIMEDOUT",     // Timeout dell'operazione
    "ECONNREFUSED",  // Connessione rifiutata (es. server giù)
    "ENOTFOUND",     // Impossibile risolvere il DNS
    "EAI_AGAIN",     // Errore DNS temporaneo
    "UND_ERR_CONNECT_TIMEOUT" // Timeout specifico di undici (usato da Node.js fetch)
  ];

  // Controlla l'error code principale o il cause (se l'errore è incapsulato)
  if (networkErrorCodes.includes(e.code) || (e.cause && networkErrorCodes.includes(e.cause.code))) {
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
