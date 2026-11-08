import type { ComponentParamSnapshot } from "../../src/shared/protocol";
import { jsonValue } from "./json-value";
import {
  timelineKeyframeSeconds,
  type KeyframeItemTiming,
} from "./keyframe-time";

export async function snapshotComponentParam(
  param: any,
  paramIndex: number,
  itemInPoint: any,
  seconds: (time: any) => number,
  timing: KeyframeItemTiming = { startSeconds: 0, inPointSeconds: 0 },
): Promise<ComponentParamSnapshot> {
  let value: ComponentParamSnapshot["value"] = null;
  let valueReliability: "complete" | "unavailable" = "complete";
  try {
    value = jsonValue(await param.getStartValue());
    if (value === null)
      value = jsonValue(await param.getValueAtTime(itemInPoint));
    if (value === null) valueReliability = "unavailable";
  } catch {
    // TextDocument-style MOGRT parameters are exposed by name but do not
    // return a public primitive value. Unknown objects and transient read
    // failures are also incomplete: stringifying them would create a
    // misleadingly stable revision.
    valueReliability = "unavailable";
  }

  let keyframes: ComponentParamSnapshot["keyframes"] = [];
  try {
    for (const time of param.getKeyframeListAsTickTimes()) {
      const keyframe = param.getKeyframePtr(time);
      const keyframeValue = jsonValue(await param.getValueAtTime(time));
      if (keyframeValue === null)
        throw new Error("Keyframe value is unavailable");
      keyframes.push({
        timeSeconds: timelineKeyframeSeconds(timing, seconds(time)),
        value: keyframeValue,
        temporalInterpolationMode:
          await keyframe.getTemporalInterpolationMode(),
      });
    }
  } catch {
    valueReliability = "unavailable";
    keyframes = [];
  }

  return {
    index: paramIndex,
    displayName: String(param.displayName || `Parameter ${paramIndex}`),
    value,
    valueReliability,
    timeVarying: Boolean(param.isTimeVarying()),
    keyframes,
  };
}
