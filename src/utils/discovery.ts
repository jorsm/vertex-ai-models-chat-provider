import { isRetryableError } from "./retry";

export const DISCOVERY_PROBE_TIMEOUT_MS = 45_000;
export const DISCOVERY_MAX_RETRIES = 3;
export const DISCOVERY_MAX_CONCURRENCY = 3;

export function getDiscoveryStartDelayMs(): number {
  return 500 + Math.floor(Math.random() * 500);
}

export class DiscoveryRetryableError extends Error {
  constructor(error: any, readonly reachable: boolean) {
    super(String(error?.message || error?.status || error?.code || error), { cause: error });
    this.name = "DiscoveryRetryableError";
  }
}

/** Reject invalid values and delays that would overflow Node's timer. */
export function resolveDiscoveryTimeoutMs(seconds: unknown): number {
  return typeof seconds === "number" && Number.isInteger(seconds) && seconds >= 1 && seconds <= 2_147_483
    ? seconds * 1000
    : DISCOVERY_PROBE_TIMEOUT_MS;
}

export interface DiscoveryProbeOptions {
  signal: AbortSignal;
  timeoutMs: number;
}

/** Bound the entire probe, including SDK setup and authentication. */
export async function probeWithDeadline(
  probe: (options: DiscoveryProbeOptions) => Promise<boolean>,
  parentSignal: AbortSignal,
  onTimeout: () => void,
  timeoutMs = DISCOVERY_PROBE_TIMEOUT_MS,
  timeoutResult: () => boolean = () => false,
): Promise<boolean> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel = () => {};
  const stopped = new Promise<boolean>((resolve) => {
    const stop = (reachable: boolean) => {
      // Settle before aborting: an SDK abort handler must not win the race.
      resolve(reachable);
      controller.abort();
    };
    cancel = () => stop(false);
    timer = setTimeout(() => {
      onTimeout();
      stop(timeoutResult());
    }, timeoutMs);
    parentSignal.addEventListener("abort", cancel, { once: true });
    if (parentSignal.aborted) {
      cancel();
    }
  });

  try {
    return await Promise.race([
      Promise.resolve().then(() => controller.signal.aborted ? false : probe({ signal: controller.signal, timeoutMs })),
      stopped,
    ]);
  } finally {
    clearTimeout(timer);
    parentSignal.removeEventListener("abort", cancel);
  }
}

/** A server rate-limit response proves reachability; transport failures do not. */
export function isDiscoveryRateLimitError(error: any): boolean {
  const status = error?.status ?? error?.code ?? error?.error?.code ?? error?.response?.status;
  return String(status) === "429" || status === "RESOURCE_EXHAUSTED" || /\b429\b|resource[_ ]exhausted|too many requests/i.test(error?.message || "");
}

export function getDiscoveryRetryableError(error: any): DiscoveryRetryableError | undefined {
  const status = Number(error?.status ?? error?.code ?? error?.error?.code ?? error?.response?.status);
  // Explicit client errors must not be retried because their text mentions quota.
  if (status >= 400 && status < 500 && ![408, 409, 429].includes(status)) {
    return undefined;
  }
  const reachable = isDiscoveryRateLimitError(error);
  if (reachable || isRetryableError(error) || status === 408 || status === 409 || (status >= 500 && status < 600) || error?.name === "APIConnectionTimeoutError") {
    return new DiscoveryRetryableError(error, reachable);
  }
  return undefined;
}

/** Cancel timers promptly when discovery stops, including during backoff. */
export function waitForDiscoveryDelay(delayMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted || delayMs <= 0) {
    return Promise.resolve(!signal.aborted);
  }
  return new Promise((resolve) => {
    const finish = (completed: boolean) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      resolve(completed);
    };
    const cancel = () => finish(false);
    const timer = setTimeout(() => finish(true), delayMs);
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) {
      cancel();
    }
  });
}

/** One deadline covers all attempts and backoff; 429 evidence survives exhaustion. */
export async function probeWithRetries(
  probe: (options: DiscoveryProbeOptions) => Promise<boolean>,
  signal: AbortSignal,
  onTimeout: (reachable: boolean) => void,
  timeoutMs: number,
  log: (message: string) => void,
): Promise<boolean> {
  let reachable = false;
  return probeWithDeadline(async (options) => {
    const deadline = Date.now() + options.timeoutMs;
    for (let retry = 0; retry <= DISCOVERY_MAX_RETRIES; retry++) {
      if (options.signal.aborted) {
        return false;
      }
      try {
        return await probe({ ...options, timeoutMs: Math.max(1, deadline - Date.now()) });
      } catch (error) {
        if (options.signal.aborted) {
          return false;
        }
        if (!(error instanceof DiscoveryRetryableError)) {
          throw error;
        }
        reachable ||= error.reachable;
        if (retry === DISCOVERY_MAX_RETRIES) {
          log(`Retries exhausted; endpoint ${reachable ? "reachable (rate limited)" : "unavailable"}.`);
          return reachable;
        }
        const baseDelay = 1000 * 2 ** retry;
        const cause: any = error.cause;
        const retryAfter = cause?.headers?.get?.("retry-after") ?? cause?.headers?.["retry-after"];
        const retryAfterMs = retryAfter === undefined ? 0 : Number.isFinite(Number(retryAfter))
          ? Math.max(0, Number(retryAfter) * 1000) : Math.max(0, Date.parse(retryAfter) - Date.now()) || 0;
        const delay = Math.min(Math.max(0, deadline - Date.now()), Math.max(baseDelay + Math.floor(Math.random() * baseDelay), retryAfterMs));
        log(`Retry ${retry + 1}/${DISCOVERY_MAX_RETRIES} in ${delay}ms after ${error.message}.`);
        if (!await waitForDiscoveryDelay(delay, options.signal)) {
          return false;
        }
      }
    }
    return reachable;
  }, signal, () => onTimeout(reachable), timeoutMs, () => reachable);
}

/** Share a paced start queue and allow at most three active endpoints. */
export async function runDiscoveryQueue<T, R>(
  targets: readonly T[],
  probe: (target: T) => Promise<R>,
  signal: AbortSignal,
  startDelayMs: () => number = getDiscoveryStartDelayMs,
): Promise<R[]> {
  const results: (R | undefined)[] = new Array(targets.length);
  let next = 0;
  let failed = false;
  let turn = Promise.resolve(true);
  const worker = async () => {
    while (!failed && !signal.aborted && next < targets.length) {
      const index = next++;
      turn = turn.then((active) => active && !failed ? waitForDiscoveryDelay(startDelayMs(), signal) : false);
      if (!await turn || failed || signal.aborted) {
        return;
      }
      try {
        results[index] = await probe(targets[index]);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(DISCOVERY_MAX_CONCURRENCY, targets.length) }, worker));
  return results.filter((result): result is R => result !== undefined);
}
