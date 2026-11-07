import assert from "node:assert/strict";
import test from "node:test";
import {
  assertMogrtTextUnchanged,
  isMogrtText,
} from "../plugin/src/mogrt-text.js";
import { jsonValue } from "../plugin/src/json-value.js";

function mogrtText(text: string): any {
  return { getText: () => text, setText: () => true };
}

test("recognizes only objects that can read and write text", () => {
  assert.equal(isMogrtText(mogrtText("a")), true);
  assert.equal(isMogrtText({ getText: () => "a" }), false);
  assert.equal(isMogrtText(null), false);
});

test("refuses to write MOGRT text so Premiere cannot erase it", () => {
  assert.throws(
    () => assertMogrtTextUnchanged(mogrtText("before")),
    /Writing MOGRT text is disabled/,
  );
});

test("allows ordinary parameter values", () => {
  assert.doesNotThrow(() => assertMogrtTextUnchanged({ value: 1 }));
});

test("snapshots MOGRT text as its string content", () => {
  assert.equal(jsonValue(mogrtText("タイトル")), "タイトル");
});
