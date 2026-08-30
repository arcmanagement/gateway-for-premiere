import type { JsonValue } from "../../src/shared/protocol";

export function jsonValue(value: any): JsonValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new Error("Component value contains a non-finite number");
    return value;
  }
  if (typeof value === "string" || typeof value === "boolean") return value;
  // Premiere 26.3 exposes PointF as a two-number array in some component
  // values even though the public type is PointF. Normalize only that exact
  // runtime shape; arbitrary arrays remain unsupported.
  if (
    Array.isArray(value) &&
    value.length === 2 &&
    value.every((entry) =>
      typeof entry === "number" ? Number.isFinite(entry) : false,
    )
  ) {
    return { x: value[0], y: value[1] };
  }
  if (
    typeof value.x === "number" &&
    Number.isFinite(value.x) &&
    typeof value.y === "number" &&
    Number.isFinite(value.y)
  ) {
    return { x: value.x, y: value.y };
  }
  if (
    typeof value.red === "number" &&
    Number.isFinite(value.red) &&
    typeof value.green === "number" &&
    Number.isFinite(value.green) &&
    typeof value.blue === "number" &&
    Number.isFinite(value.blue) &&
    typeof value.alpha === "number" &&
    Number.isFinite(value.alpha)
  ) {
    return {
      red: value.red,
      green: value.green,
      blue: value.blue,
      alpha: value.alpha,
    };
  }
  if (typeof value === "object" && "value" in value) {
    const nested = value.value;
    if (nested !== value) return jsonValue(nested);
  }
  throw new Error(
    "Component value is not a public primitive, PointF, or Color",
  );
}
