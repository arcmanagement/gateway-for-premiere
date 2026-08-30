import assert from "node:assert/strict";
import test from "node:test";
import {
  isStableEditingSnapshotPair,
  type EditingSnapshotObservation,
} from "../plugin/src/editing-snapshot-stability.js";

function observation(
  overrides: Partial<EditingSnapshotObservation> = {},
): EditingSnapshotObservation {
  return {
    startProjectGuid: "project-1",
    startSequenceGuid: "sequence-1",
    endProjectGuid: "project-1",
    endSequenceGuid: "sequence-1",
    projectItemsProjectGuid: "project-1",
    timelineProjectGuid: "project-1",
    timelineSequenceGuid: "sequence-1",
    projectItemsRevision: "items-1",
    timelineRevision: "timeline-1",
    ...overrides,
  };
}

test("accepts only two observations of the same stable editing state", () => {
  assert.equal(isStableEditingSnapshotPair(observation(), observation()), true);
});

test("rejects a project or sequence switch during either observation", () => {
  assert.equal(
    isStableEditingSnapshotPair(
      observation({ endSequenceGuid: "sequence-2" }),
      observation(),
    ),
    false,
  );
  assert.equal(
    isStableEditingSnapshotPair(
      observation(),
      observation({ startProjectGuid: "project-2" }),
    ),
    false,
  );
});

test("rejects project-item or timeline changes between observations", () => {
  assert.equal(
    isStableEditingSnapshotPair(
      observation(),
      observation({ projectItemsRevision: "items-2" }),
    ),
    false,
  );
  assert.equal(
    isStableEditingSnapshotPair(
      observation(),
      observation({ timelineRevision: "timeline-2" }),
    ),
    false,
  );
});

test("rejects embedded snapshots from another project or sequence", () => {
  assert.equal(
    isStableEditingSnapshotPair(
      observation(),
      observation({ projectItemsProjectGuid: "project-2" }),
    ),
    false,
  );
  assert.equal(
    isStableEditingSnapshotPair(
      observation(),
      observation({ timelineSequenceGuid: "sequence-2" }),
    ),
    false,
  );
});
