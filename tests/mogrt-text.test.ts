import assert from "node:assert/strict";
import test from "node:test";
import { editedMogrtText, isMogrtText } from "../plugin/src/mogrt-text.js";
import { jsonValue } from "../plugin/src/json-value.js";

function mogrtText(initial: string, accepted = true): any {
  let text = initial;
  return {
    getText: () => text,
    setText: (next: string) => {
      if (accepted) text = next;
      return accepted;
    },
  };
}

test("recognizes only objects that can read and write text", () => {
  assert.equal(isMogrtText(mogrtText("a")), true);
  assert.equal(isMogrtText({ getText: () => "a" }), false);
  assert.equal(isMogrtText(null), false);
});

test("edits the current text object so its styling is kept", () => {
  const current = mogrtText("before");
  assert.equal(editedMogrtText(current, "after"), current);
  assert.equal(current.getText(), "after");
});

test("fails when Premiere rejects the text", () => {
  assert.throws(
    () => editedMogrtText(mogrtText("before", false), "after"),
    /rejected the MOGRT text/,
  );
});

test("snapshots MOGRT text as its string content", () => {
  assert.equal(jsonValue(mogrtText("タイトル")), "タイトル");
});
