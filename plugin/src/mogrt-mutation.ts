import type { TimelineSnapshot } from "../../src/shared/protocol";
import { RequestUnknownOutcomeError } from "./request-journal";
import {
  waitForStableRevision,
  type RevisionStabilityOptions,
} from "./timeline-stability";

export interface MogrtMutationOptions<T extends TimelineSnapshot> {
  beforeRevision: string;
  prepare: () => Promise<void>;
  start: (markStarted: () => void) => number;
  readSnapshot: () => Promise<T>;
  stabilityOptions?: RevisionStabilityOptions;
}

export async function runMogrtMutation<T extends TimelineSnapshot>(
  options: MogrtMutationOptions<T>,
): Promise<{ timeline: T; insertedItemCount: number }> {
  // Identity, revision, connection, and request deadline are checked here,
  // before the non-Action host call can begin.
  await options.prepare();

  let started = false;
  let insertedItemCount = 0;
  let insertionError: unknown;
  try {
    insertedItemCount = options.start(() => {
      started = true;
    });
  } catch (error) {
    if (!started) throw error;
    insertionError = error;
  }
  if (!started) throw new Error("Premiere could not start MOGRT insertion");

  let result;
  try {
    result = await waitForStableRevision(
      options.readSnapshot,
      options.stabilityOptions,
    );
  } catch {
    throw new RequestUnknownOutcomeError(
      "MOGRT insertion started, but its timeline outcome could not be read",
    );
  }
  const after = result.snapshot;
  if (insertionError) {
    throw new RequestUnknownOutcomeError(
      "MOGRT insertion outcome could not be confirmed",
      undefined,
      after.revision,
    );
  }
  if (!result.stable) {
    throw new RequestUnknownOutcomeError(
      "MOGRT insertion started, but its timeline did not stabilize",
      undefined,
      after.revision,
    );
  }
  if (insertedItemCount === 0 || after.revision === options.beforeRevision) {
    if (after.revision !== options.beforeRevision) {
      throw new RequestUnknownOutcomeError(
        "MOGRT insertion changed the timeline without a confirmed item",
        undefined,
        after.revision,
      );
    }
    throw new Error("Premiere did not insert the MOGRT");
  }
  return { timeline: after, insertedItemCount };
}
