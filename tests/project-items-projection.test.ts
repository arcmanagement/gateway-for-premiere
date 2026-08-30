import assert from "node:assert/strict";
import test from "node:test";
import { projectItemsAtDepth } from "../plugin/src/project-items-projection.js";
import type { ProjectItemSnapshot } from "../src/shared/protocol.js";

const fullTree: ProjectItemSnapshot[] = [
  {
    id: "bin-1",
    name: "Bin",
    type: 2,
    kind: "bin",
    children: [
      {
        id: "bin-2",
        name: "Nested",
        type: 2,
        kind: "bin",
        children: [
          {
            id: "clip-1",
            name: "Clip",
            type: 1,
            kind: "clip",
            mediaPath: "/media/clip.mov",
          },
        ],
      },
    ],
  },
];

test("projects a requested depth from one full in-memory item tree", () => {
  assert.deepEqual(projectItemsAtDepth(fullTree, 0), [
    { id: "bin-1", name: "Bin", type: 2, kind: "bin" },
  ]);
  assert.deepEqual(projectItemsAtDepth(fullTree, 1), [
    {
      id: "bin-1",
      name: "Bin",
      type: 2,
      kind: "bin",
      children: [{ id: "bin-2", name: "Nested", type: 2, kind: "bin" }],
    },
  ]);
  assert.deepEqual(projectItemsAtDepth(fullTree, 2), fullTree);
});

test("does not mutate the full tree used to calculate the revision", () => {
  const before = JSON.stringify(fullTree);
  projectItemsAtDepth(fullTree, 0);
  assert.equal(JSON.stringify(fullTree), before);
});
