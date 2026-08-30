import assert from "node:assert/strict";
import test from "node:test";
import { snapshotComponentParam } from "../plugin/src/component-param-snapshot.js";

function param(overrides: Record<string, unknown> = {}): any {
  return {
    displayName: "Source Text",
    getStartValue: async () => ({ value: 1 }),
    getValueAtTime: async () => 1,
    getKeyframeListAsTickTimes: () => [],
    getKeyframePtr: () => ({
      getTemporalInterpolationMode: async () => 0,
    }),
    isTimeVarying: () => false,
    ...overrides,
  };
}

const seconds = (time: { seconds: number }): number => time.seconds;

test("marks a parameter unavailable when both current-value reads return null", async () => {
  const snapshot = await snapshotComponentParam(
    param({
      getStartValue: async () => null,
      getValueAtTime: async () => null,
    }),
    0,
    { seconds: 0 },
    seconds,
  );
  assert.equal(snapshot.value, null);
  assert.equal(snapshot.valueReliability, "unavailable");
});

test("marks a parameter unavailable when a keyframe value cannot be read", async () => {
  const snapshot = await snapshotComponentParam(
    param({
      getKeyframeListAsTickTimes: () => [{ seconds: 1 }],
      getValueAtTime: async () => {
        throw new Error("unsupported keyframe value");
      },
    }),
    0,
    { seconds: 0 },
    seconds,
  );
  assert.equal(snapshot.valueReliability, "unavailable");
  assert.deepEqual(snapshot.keyframes, []);
});

test("marks a parameter unavailable when interpolation cannot be read", async () => {
  const snapshot = await snapshotComponentParam(
    param({
      getKeyframeListAsTickTimes: () => [{ seconds: 1 }],
      getKeyframePtr: () => ({
        getTemporalInterpolationMode: async () => {
          throw new Error("interpolation unavailable");
        },
      }),
    }),
    0,
    { seconds: 0 },
    seconds,
  );
  assert.equal(snapshot.valueReliability, "unavailable");
  assert.deepEqual(snapshot.keyframes, []);
});
