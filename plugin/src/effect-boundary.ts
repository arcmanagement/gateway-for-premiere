export const INTRINSIC_COMPONENT_COUNT = 2;

export function assertEffectInsertionIndex(
  insertionIndex: number,
  componentCount: number,
): void {
  if (insertionIndex < INTRINSIC_COMPONENT_COUNT) {
    throw new Error("Effects cannot be inserted before intrinsic components");
  }
  if (insertionIndex > componentCount) {
    throw new Error("insertionIndex exceeds component count");
  }
}

export function assertRemovableEffectIndex(
  componentIndex: number,
  componentCount: number,
): void {
  if (componentIndex < INTRINSIC_COMPONENT_COUNT) {
    throw new Error("Intrinsic components cannot be removed");
  }
  if (componentIndex >= componentCount) {
    throw new Error("componentIndex exceeds component count");
  }
}
