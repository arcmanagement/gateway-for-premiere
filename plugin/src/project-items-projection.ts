import type { ProjectItemSnapshot } from "../../src/shared/protocol";

export function projectItemsAtDepth(
  items: ProjectItemSnapshot[],
  maxDepth: number,
  depth = 0,
): ProjectItemSnapshot[] {
  return items.map((item) => {
    const { children, ...rest } = item;
    const snapshot: ProjectItemSnapshot = rest;
    if (children && depth < maxDepth) {
      snapshot.children = projectItemsAtDepth(children, maxDepth, depth + 1);
    }
    return snapshot;
  });
}
