import assert from "node:assert/strict";
import test from "node:test";
import { jsonValue } from "../plugin/src/json-value.js";

test("runtime keyframe value wrappers normalize to revision-safe JSON", () => {
  assert.equal(jsonValue({ value: 50 }), 50);
  assert.equal(jsonValue({ value: { value: 25 } }), 25);
  assert.deepEqual(jsonValue({ value: { x: 0.25, y: 0.75 } }), {
    x: 0.25,
    y: 0.75,
  });
});

test("unknown component objects and arrays are never stringified into a fake revision", () => {
  assert.throws(() => jsonValue({ textDocument: "private" }), /not a public/);
  assert.throws(() => jsonValue([1, 2, 3]), /not a public/);
  assert.throws(() => jsonValue(Number.NaN), /non-finite/);
  assert.throws(() => jsonValue({ x: Number.NaN, y: 1 }), /not a public/);
  assert.throws(
    () =>
      jsonValue({
        red: 1,
        green: Number.POSITIVE_INFINITY,
        blue: 0,
        alpha: 1,
      }),
    /not a public/,
  );
  assert.equal(jsonValue(null), null);
});

test("Premiere's two-number PointF runtime array has one canonical shape", () => {
  assert.deepEqual(jsonValue([960, 540]), { x: 960, y: 540 });
});
