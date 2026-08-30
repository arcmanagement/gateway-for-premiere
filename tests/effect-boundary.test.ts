import assert from "node:assert/strict";
import test from "node:test";
import {
  assertEffectInsertionIndex,
  assertRemovableEffectIndex,
} from "../plugin/src/effect-boundary.js";

test("effects cannot cross the two intrinsic component slots", () => {
  assert.throws(() => assertEffectInsertionIndex(1, 2), /intrinsic/);
  assert.doesNotThrow(() => assertEffectInsertionIndex(2, 2));
  assert.throws(() => assertEffectInsertionIndex(3, 2), /exceeds/);

  assert.throws(() => assertRemovableEffectIndex(1, 3), /Intrinsic/);
  assert.doesNotThrow(() => assertRemovableEffectIndex(2, 3));
  assert.throws(() => assertRemovableEffectIndex(3, 3), /exceeds/);
});
