import * as vscode from "vscode";
import { Logger } from "./Logger";

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
    shouldRetry?: (error: any) => boolean;
    retryDelayMs?: (error: any) => number;
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

// ─── Logger instance for retry operations ────────────────────────────────────
const logger = new Logger("Retry");

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
    let retryStartTime: number | undefined;
    let longRetryNotificationTimer: ReturnType<typeof setTimeout> | undefined;
    let finished = false;
    let lastErrorSummary = "";

    const emitLog = (msg: string) => {
        logger.log(msg);
        options?.log?.(msg);
    };

    const cleanupTimer = () => {
        if (longRetryNotificationTimer) {
            clearTimeout(longRetryNotificationTimer);
            longRetryNotificationTimer = undefined;
        }
    };

    const ensureLongRetryTimer = () => {
        if (retryStartTime === undefined) {
            retryStartTime = Date.now();
        }
        if (longRetryNotificationTimer || maxRetryDurationMs <= 60_000) {
            return;
        }
        longRetryNotificationTimer = setTimeout(() => {
            if (finished || options?.token?.isCancellationRequested || attempt === 0) {
                return;
            }

            const retryElapsedMs = Date.now() - (retryStartTime ?? startTime);
            const remainingMs = maxRetryDurationMs - retryElapsedMs;
            if (retryElapsedMs >= 60_000 && remainingMs > 0) {
                const remainingMinutes = Math.max(1, Math.round(remainingMs / 60000));
                const reasonSuffix = lastErrorSummary ? ` Last error: ${lastErrorSummary}.` : "";
                emitLog(`⏳ Request still failing after ${attempt} retry attempt(s) (${Math.round(retryElapsedMs / 1000)}s).${reasonSuffix} Will continue retrying for up to ${remainingMinutes} more minute(s).`);
                void vscode.window.showWarningMessage(
                    `Vertex AI Models Chat Provider: the request has been failing for an extended time (${lastErrorSummary || "temporary service error"}). The extension has already retried for 1 minute, but the service is still having issues. Without action, it will continue retrying for the next ${remainingMinutes} minutes (based on configuration). If you want to stop it, use the Stop/Cancel button in the agent chat.`,
                );
            }
        }, 60_000);
    };

    while (true) {
        if (options?.token?.isCancellationRequested) {
            cleanupTimer();
            throw new Error("Cancelled by user");
        }

        const currentAttemptNumber = attempt + 1;
        if (attempt > 0) {
            const maxLabel = maxRetries < Number.MAX_SAFE_INTEGER ? `/${maxRetries}` : "";
            emitLog(`🔄 Executing retry ${attempt}${maxLabel} (attempt ${currentAttemptNumber})...`);
        }

        try {
            const result = await operation();
            finished = true;
            cleanupTimer();
            logRetrySummary(true, attempt, retryLog, undefined, emitLog);
            return result;
        } catch (e: any) {
            const retryElapsedMs = retryStartTime !== undefined ? Date.now() - retryStartTime : 0;
            const retryable = (options?.shouldRetry ?? isRetryableError)(e);
            if (!retryable || attempt >= maxRetries || retryElapsedMs >= maxRetryDurationMs) {
                cleanupTimer();
                if (attempt === 0) {
                    emitLog(`❌ Attempt 1 failed (${retryable ? "retry budget exhausted" : "non-retryable"}): ${describeRetryError(e)}`);
                } else {
                    logRetrySummary(false, attempt, retryLog, e, emitLog);
                }
                throw e;
            }

            ensureLongRetryTimer();
            attempt++;
            const currentRetryElapsedMs = Date.now() - (retryStartTime ?? startTime);
            const delayMs = Math.max(calculateDelay(attempt, baseDelayMs, maxDelayMs), options?.retryDelayMs?.(e) ?? extractRetryAfterDelayMs(e));
            const timeLeftMs = Math.max(0, maxRetryDurationMs - currentRetryElapsedMs);
            const actualDelayMs = Math.min(delayMs, timeLeftMs);

            if (actualDelayMs <= 0) {
                cleanupTimer();
                logRetrySummary(false, attempt, retryLog, e, emitLog);
                throw e;
            }

            lastErrorSummary = describeRetryError(e);
            handleRetryAttempt(attempt, maxRetries, actualDelayMs, e, lastErrorSummary, retryLog, options?.log);
            try {
                await new Promise<void>((resolve, reject) => {
                    let subscription: vscode.Disposable | undefined;
                    const timer = setTimeout(() => {
                        subscription?.dispose();
                        resolve();
                    }, actualDelayMs);
                    const cancel = () => {
                        clearTimeout(timer);
                        subscription?.dispose();
                        reject(new vscode.CancellationError());
                    };
                    subscription = options?.token?.onCancellationRequested(cancel);
                    if (options?.token?.isCancellationRequested) {
                        cancel();
                    }
                });
            } catch (error) {
                cleanupTimer();
                throw error;
            }
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

export function describeRetryError(e: any): string {
    if (!e) {
        return "Unknown error";
    }
    let payload = e?.error;
    if (!payload && typeof e?.message === "string") {
        try {
            payload = JSON.parse(e.message);
        } catch {
            /* SDK message is not JSON. */
        }
    }
    const detail = payload?.error ?? payload;
    const status = e?.status ?? e?.code ?? detail?.code ?? e?.response?.status;
    const code = e?.policyCode ?? detail?.status ?? detail?.reason ?? e?.cause?.code;
    const rawMessage = detail?.message || e?.message || String(e);

    const tags: string[] = [];
    if (status !== undefined && status !== null && String(status) !== "") {
        tags.push(typeof status === "number" || /^\d{3}$/.test(String(status)) ? `HTTP ${status}` : String(status));
    }
    if (code && String(code) !== String(status)) {
        tags.push(String(code));
    }
    const prefix = tags.length > 0 ? `[${tags.join(" ")}] ` : "";
    return `${prefix}${rawMessage}`;
}

function logRetrySummary(success: boolean, attempt: number, retryLog: RetryLogEntry[], error: any, emitLog: (msg: string) => void) {
    if (attempt === 0) {
        return;
    }
    const message = success ? `✅ Retry ${attempt} succeeded (operation completed after ${attempt + 1} total attempts).` : `❌ Attempt ${attempt + 1} failed; operation aborted after ${attempt} retries. Final error: ${describeRetryError(error)}`;
    emitLog(message);
    emitLog(`   Retry history: ${JSON.stringify(retryLog, null, 2)}`);
}

function handleRetryAttempt(attempt: number, maxRetries: number, delayMs: number, e: any, errorSummary: string, retryLog: RetryLogEntry[], customLog?: (msg: string) => void) {
    const roundedDelay = Math.round(delayMs);
    retryLog.push({
        attempt,
        delayMs: roundedDelay,
        error: errorSummary,
        timestamp: new Date().toISOString(),
    });

    const maxLabel = maxRetries < Number.MAX_SAFE_INTEGER ? `/${maxRetries}` : "";
    const msg = `⚠️ Attempt ${attempt} failed with retryable error: ${errorSummary}. Retrying in ${roundedDelay}ms (retry ${attempt}${maxLabel})...`;
    logger.error(msg, e);
    customLog?.(msg);
}

// Native Node.js / Fetch network error codes that are safe to retry
const NETWORK_ERROR_CODES = new Set([
    "ECONNRESET", // Connection reset by peer
    "ETIMEDOUT", // Operation timeout
    "ECONNREFUSED", // Connection refused (e.g. server down)
    "ENOTFOUND", // DNS lookup failed
    "EAI_AGAIN", // Temporary DNS error
    "UND_ERR_CONNECT_TIMEOUT", // Undici/Node.js fetch specific timeout
    "UND_ERR_SOCKET", // Undici/Node.js socket closed while streaming
]);

export function extractRetryAfterDelayMs(error: any): number {
    const headers = error?.headers ?? error?.response?.headers;
    const raw = headers?.get?.("retry-after") ?? headers?.["retry-after"];
    if (!raw) {
        return 0;
    }
    const seconds = Number(raw);
    const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(raw) - Date.now();
    return Number.isFinite(delay) ? Math.max(0, delay) : 0;
}

/**
 * Determines if an error is transient and should trigger a retry.
 * Matches common rate limiting (429) and server overload (500/502/503/504) patterns
 * across both direct Vertex AI and proxy gateway modes.
 */
export function isRetryableError(e: any): boolean {
    if (!e) {
        return false;
    }

    let payload = e?.error;
    if (!payload && typeof e?.message === "string") {
        try {
            payload = JSON.parse(e.message);
        } catch {
            /* SDK message is not JSON. */
        }
    }
    const detail = payload?.error ?? payload;
    const policyCode = e?.policyCode ?? detail?.reason ?? detail?.status;
    if (policyCode === "UPSTREAM_AUTHENTICATION_FAILED") {
        return false;
    }

    const rawStatus = e?.status ?? e?.code ?? detail?.code ?? e?.response?.status;
    const numericStatus = Number(rawStatus);
    if (Number.isInteger(numericStatus) && numericStatus >= 100 && numericStatus < 600) {
        if (numericStatus >= 400 && numericStatus < 500 && numericStatus !== 408 && numericStatus !== 429) {
            return false;
        }
        if (numericStatus === 408 || numericStatus === 429 || numericStatus === 500 || numericStatus === 502 || numericStatus === 503 || numericStatus === 504) {
            return true;
        }
    }

    if (e.status === "RESOURCE_EXHAUSTED" || detail?.status === "RESOURCE_EXHAUSTED" || detail?.status === "UNAVAILABLE" || detail?.status === "INTERNAL") {
        return true;
    }

    // Check the main error code or the cause (if the error is wrapped)
    if (NETWORK_ERROR_CODES.has(e.code) || (e.cause && NETWORK_ERROR_CODES.has(e.cause.code))) {
        return true;
    }

    const msg = (e.message || e.toString()).toLowerCase();

    // 429 Too Many Requests / Resource Exhausted
    if (msg.includes("429") || msg.includes("too many requests") || msg.includes("resource_exhausted") || msg.includes("resource exhausted") || msg.includes("quota")) {
        return true;
    }

    // 503 Service Unavailable / 502 Bad Gateway / 500 Internal Server Error
    if (msg.includes("503") || msg.includes("service unavailable") || msg.includes("overloaded") || msg.includes("502") || msg.includes("bad gateway") || msg.includes("internal server error")) {
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
        throw new VertexAuthenticationError("Google Cloud credentials have expired or are invalid. Please check your Project ID and Service Account permissions, or run 'gcloud auth application-default login' in your terminal.");
    }
}
