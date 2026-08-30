import assert from "node:assert/strict";
import test from "node:test";
import {
  timelineItemRef,
  timelineTransitionRef,
  trackSnapshotHeader,
} from "../plugin/src/track-snapshot";

test("track snapshots and child refs use Premiere's host track index", async () => {
  const track = {
    id: 42,
    name: "Host track",
    getIndex: async () => 7,
    isMuted: async () => true,
  };

  const header = await trackSnapshotHeader(track, "video");

  assert.deepEqual(header, {
    mediaType: "video",
    index: 7,
    id: 42,
    name: "Host track",
    muted: true,
  });
  assert.equal(timelineItemRef("video", header.index, 3), "video:7:3");
  assert.equal(
    timelineTransitionRef("video", header.index, 4),
    "video-transition:7:4",
  );
});

test("track snapshots reject an invalid host track index", async () => {
  await assert.rejects(
    trackSnapshotHeader(
      {
        id: 42,
        name: "Broken track",
        getIndex: async () => Number.NaN,
        isMuted: async () => false,
      },
      "audio",
    ),
    /invalid track index/,
  );
});
