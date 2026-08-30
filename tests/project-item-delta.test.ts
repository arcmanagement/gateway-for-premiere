import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectItemSnapshot } from "../src/shared/protocol.js";
import { importedProjectItemsForPath } from "../plugin/src/project-item-delta.js";

function item(
  id: string,
  mediaPath?: string,
  children?: ProjectItemSnapshot[],
): ProjectItemSnapshot {
  return {
    id,
    name: id,
    type: children ? 2 : 1,
    kind: children ? "bin" : "clip",
    ...(mediaPath ? { mediaPath } : {}),
    ...(children ? { children } : {}),
  };
}

test("import postcondition only accepts a new item for the requested path", () => {
  const before = [item("existing", "/media/existing.wav")];
  const after = [
    ...before,
    item("unrelated", "/media/concurrent.wav"),
    item("requested", "/media/requested.wav"),
  ];

  assert.deepEqual(
    importedProjectItemsForPath(before, after, "/media/requested.wav").map(
      ({ id }) => id,
    ),
    ["requested"],
  );
});

test("import postcondition ignores an unrelated concurrent addition", () => {
  const before = [item("bin", undefined, [])];
  const after = [
    item("bin", undefined, [item("unrelated", "/media/concurrent.wav")]),
  ];

  assert.deepEqual(
    importedProjectItemsForPath(before, after, "/media/requested.wav"),
    [],
  );
});
