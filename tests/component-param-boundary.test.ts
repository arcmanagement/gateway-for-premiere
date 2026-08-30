import assert from "node:assert/strict";
import test from "node:test";
import type { ComponentSnapshot } from "../src/shared/protocol.js";
import { readableComponentParam } from "../plugin/src/component-param-boundary.js";

function components(
  valueReliability: "complete" | "unavailable",
): ComponentSnapshot[] {
  return [
    {
      index: 2,
      displayName: "Graphic Parameters",
      matchName: "Graphic Parameters",
      params: [
        {
          index: 5,
          displayName: "Main Color",
          value: { red: 1, green: 0, blue: 0, alpha: 1 },
          valueReliability,
          timeVarying: false,
          keyframes: [],
        },
      ],
    },
  ];
}

test("allows editing a target parameter whose value is complete", () => {
  assert.equal(readableComponentParam(components("complete"), 2, 5).index, 5);
});

test("rejects editing the unavailable target even with a broader override", () => {
  assert.throws(
    () => readableComponentParam(components("unavailable"), 2, 5),
    /only public primitive parameters can be edited/,
  );
});
