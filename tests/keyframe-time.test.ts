import assert from "node:assert/strict";
import test from "node:test";
import {
  mediaKeyframeSeconds,
  timelineKeyframeSeconds,
} from "../plugin/src/keyframe-time.js";

test("maps sequence time onto a graphic whose media starts near one hour", () => {
  const item = { startSeconds: 0, inPointSeconds: 3599.93 };
  assert.equal(mediaKeyframeSeconds(item, 0.5), 3600.43);
});

test("maps sequence time onto a clip placed later on the timeline", () => {
  const item = { startSeconds: 10, inPointSeconds: 2 };
  assert.equal(mediaKeyframeSeconds(item, 12), 4);
});

test("round-trips media time back to sequence time", () => {
  const item = { startSeconds: 10, inPointSeconds: 2 };
  assert.equal(
    timelineKeyframeSeconds(item, mediaKeyframeSeconds(item, 12)),
    12,
  );
});

test("refuses retimed items instead of placing a keyframe at the wrong time", () => {
  const item = { startSeconds: 0, inPointSeconds: 0, speed: 2 };
  assert.throws(() => mediaKeyframeSeconds(item, 1), /retimed items/);
});
