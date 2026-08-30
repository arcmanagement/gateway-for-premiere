import assert from "node:assert/strict";
import test from "node:test";
import { timelineRevisionReliability } from "../plugin/src/timeline-reliability.js";

test("caption items make timeline revisions fail closed", () => {
  assert.equal(
    timelineRevisionReliability({
      hasOpaqueTransitions: false,
      hasIncompleteComponents: false,
      hasOpaqueCaptions: true,
    }),
    "opaque-captions",
  );
  assert.equal(
    timelineRevisionReliability({
      hasOpaqueTransitions: true,
      hasIncompleteComponents: false,
      hasOpaqueCaptions: true,
    }),
    "multiple-incomplete",
  );
  assert.equal(
    timelineRevisionReliability({
      hasOpaqueTransitions: false,
      hasIncompleteComponents: false,
      hasOpaqueCaptions: false,
    }),
    "complete",
  );
});
