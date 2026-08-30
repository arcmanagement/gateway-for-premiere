import assert from "node:assert/strict";
import test from "node:test";
import { runMogrtMutation } from "../plugin/src/mogrt-mutation.js";
import {
  RequestDeadlineExpiredError,
  RequestUnknownOutcomeError,
} from "../plugin/src/request-journal.js";
import type { TimelineSnapshot } from "../src/shared/protocol.js";

function timeline(revision: string): TimelineSnapshot {
  return {
    project: { guid: "project-1", name: "Project", path: "/project.prproj" },
    sequence: { guid: "sequence-1", name: "Sequence" },
    revision,
    revisionReliability: "complete",
    tracks: [],
    captionTracks: [],
    markers: [],
  };
}

test("does not start MOGRT insertion after a preflight deadline failure", async () => {
  let started = false;
  await assert.rejects(
    runMogrtMutation({
      beforeRevision: "before",
      prepare: async () => {
        throw new RequestDeadlineExpiredError();
      },
      start: () => {
        started = true;
        return 1;
      },
      readSnapshot: async () => timeline("after"),
    }),
    RequestDeadlineExpiredError,
  );
  assert.equal(started, false);
});

test("a host throw after start becomes unknown with the observed revision", async () => {
  await assert.rejects(
    runMogrtMutation({
      beforeRevision: "before",
      prepare: async () => undefined,
      start: (markStarted) => {
        markStarted();
        throw new Error("host call failed after applying");
      },
      readSnapshot: async () => timeline("after-host-throw"),
      stabilityOptions: { stableForMs: 0 },
    }),
    (error: unknown) =>
      error instanceof RequestUnknownOutcomeError &&
      error.afterRevision === "after-host-throw",
  );
});

test("returns a confirmed item only after a stable changed revision", async () => {
  const result = await runMogrtMutation({
    beforeRevision: "before",
    prepare: async () => undefined,
    start: (markStarted) => {
      markStarted();
      return 1;
    },
    readSnapshot: async () => timeline("settled"),
    stabilityOptions: { stableForMs: 0 },
  });
  assert.equal(result.timeline.revision, "settled");
  assert.equal(result.insertedItemCount, 1);
});

test("an insertion that never stabilizes becomes unknown with its latest revision", async () => {
  let revision = 0;
  await assert.rejects(
    runMogrtMutation({
      beforeRevision: "before",
      prepare: async () => undefined,
      start: (markStarted) => {
        markStarted();
        return 1;
      },
      readSnapshot: async () => timeline(`changing-${revision++}`),
      stabilityOptions: {
        intervalMs: 1,
        stableForMs: 2,
        maxWaitMs: 2,
        sleep: async () => undefined,
      },
    }),
    (error: unknown) =>
      error instanceof RequestUnknownOutcomeError &&
      error.afterRevision === "changing-2",
  );
});
