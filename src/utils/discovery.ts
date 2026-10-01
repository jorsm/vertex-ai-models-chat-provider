export const DISCOVERY_PROBE_TIMEOUT_MS = 15_000;

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
): Promise<boolean> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel = () => {};
  const stopped = new Promise<boolean>((resolve) => {
    cancel = () => {
      // Settle before aborting: an SDK abort handler must not win the race.
      resolve(false);
      controller.abort();
    };
    timer = setTimeout(() => {
      onTimeout();
      cancel();
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
  return error?.status === 429 || error?.code === 429 || error?.status === "RESOURCE_EXHAUSTED" || error?.code === "RESOURCE_EXHAUSTED";
}
