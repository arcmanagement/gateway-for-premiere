import assert from "node:assert/strict";
import test from "node:test";
import { waitForStableRevision } from "../plugin/src/timeline-stability.js";

test("waits for a continuous stable revision window after host changes", async () => {
  const revisions = ["initial", "initial", "settled", "settled", "settled"];
  let index = 0;
  const result = await waitForStableRevision(
    async () => ({ revision: revisions[index++] ?? "settled" }),
    {
      intervalMs: 10,
      stableForMs: 20,
      maxWaitMs: 50,
      sleep: async () => undefined,
    },
  );
  assert.deepEqual(result, {
    snapshot: { revision: "settled" },
    stable: true,
  });
});

test("returns the latest snapshot as unstable when the host keeps changing", async () => {
  let revision = 0;
  const result = await waitForStableRevision(
    async () => ({ revision: String(revision++) }),
    {
      intervalMs: 10,
      stableForMs: 20,
      maxWaitMs: 30,
      sleep: async () => undefined,
    },
  );
  assert.deepEqual(result, {
    snapshot: { revision: "3" },
    stable: false,
  });
});
