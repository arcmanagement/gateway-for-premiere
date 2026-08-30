import type {
  ComponentParamSnapshot,
  ComponentSnapshot,
} from "../../src/shared/protocol";

export function readableComponentParam(
  components: ComponentSnapshot[],
  componentIndex: number,
  paramIndex: number,
): ComponentParamSnapshot {
  const component = components.find((entry) => entry.index === componentIndex);
  const param = component?.params.find((entry) => entry.index === paramIndex);
  if (!param)
    throw new Error("Target component parameter is missing from the snapshot");
  if (param.valueReliability !== "complete") {
    throw new Error(
      "Target component parameter value is unavailable; only public primitive parameters can be edited",
    );
  }
  return param;
}
