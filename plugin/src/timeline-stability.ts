export interface RevisionSnapshot {
  revision: string;
}

export interface RevisionStabilityResult<T extends RevisionSnapshot> {
  snapshot: T;
  stable: boolean;
}

export interface RevisionStabilityOptions {
  intervalMs?: number;
  stableForMs?: number;
  maxWaitMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

const defaultSleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

/**
 * Premiere may keep initializing a MOGRT after insertMogrtFromPath returns.
 * Treat the latest revision as settled only after it remains unchanged for a
 * continuous window. No request deadline is consulted here: the mutation has
 * already started, so expiry must never turn a possibly-applied write into a
 * retryable failure.
 */
export async function waitForStableRevision<T extends RevisionSnapshot>(
  readSnapshot: () => Promise<T>,
  options: RevisionStabilityOptions = {},
): Promise<RevisionStabilityResult<T>> {
  const intervalMs = options.intervalMs ?? 250;
  // AE-authored MOGRTs can expose their Graphic Parameters more than two
  // seconds after the host call returns. A five-second continuous window was
  // required by the Premiere 26.3 fixture; the full wait remains below the
  // broker's 30-second Plugin deadline.
  const stableForMs = options.stableForMs ?? 5_000;
  const maxWaitMs = options.maxWaitMs ?? 15_000;
  const sleep = options.sleep ?? defaultSleep;
  if (intervalMs <= 0) throw new Error("intervalMs must be positive");
  if (stableForMs < 0) throw new Error("stableForMs must not be negative");
  if (maxWaitMs < stableForMs)
    throw new Error("maxWaitMs must be at least stableForMs");

  let snapshot = await readSnapshot();
  if (stableForMs === 0) return { snapshot, stable: true };
  let unchangedForMs = 0;
  let waitedMs = 0;
  while (waitedMs < maxWaitMs) {
    const waitMs = Math.min(intervalMs, maxWaitMs - waitedMs);
    await sleep(waitMs);
    waitedMs += waitMs;
    const next = await readSnapshot();
    if (next.revision === snapshot.revision) {
      unchangedForMs += waitMs;
    } else {
      snapshot = next;
      unchangedForMs = 0;
    }
    if (unchangedForMs >= stableForMs) return { snapshot, stable: true };
  }
  return { snapshot, stable: false };
}
