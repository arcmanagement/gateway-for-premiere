export type KeyframeItemTiming = {
  startSeconds: number;
  inPointSeconds: number;
  speed?: number;
  reversed?: boolean;
};

// Premiere stores component keyframes in the item's media time, while the
// gateway contract is sequence time. Graphics make the difference obvious:
// their in point starts near one hour, so sequence time lands before the clip.
export function mediaKeyframeSeconds(
  item: KeyframeItemTiming,
  timelineSeconds: number,
): number {
  if ((item.speed ?? 1) !== 1 || item.reversed) {
    throw new Error("Keyframes on retimed items are not supported");
  }
  return item.inPointSeconds + timelineSeconds - item.startSeconds;
}

export function timelineKeyframeSeconds(
  item: KeyframeItemTiming,
  mediaSeconds: number,
): number {
  return item.startSeconds + mediaSeconds - item.inPointSeconds;
}
