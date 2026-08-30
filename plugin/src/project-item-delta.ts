import type { ProjectItemSnapshot } from "../../src/shared/protocol";

export function flattenProjectItemSnapshots(
  items: ProjectItemSnapshot[],
): ProjectItemSnapshot[] {
  const flattened: ProjectItemSnapshot[] = [];
  for (const item of items) {
    flattened.push(item);
    if (item.children) {
      flattened.push(...flattenProjectItemSnapshots(item.children));
    }
  }
  return flattened;
}

export function importedProjectItemsForPath(
  before: ProjectItemSnapshot[],
  after: ProjectItemSnapshot[],
  inputFile: string,
): ProjectItemSnapshot[] {
  const previousIds = new Set(
    flattenProjectItemSnapshots(before).map((item) => item.id),
  );
  return flattenProjectItemSnapshots(after).filter(
    (item) => !previousIds.has(item.id) && item.mediaPath === inputFile,
  );
}
