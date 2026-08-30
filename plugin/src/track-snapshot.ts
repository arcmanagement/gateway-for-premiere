import type { TimelineTrack } from "../../src/shared/protocol";

export type TrackMediaType = TimelineTrack["mediaType"];
export type TrackSnapshotHeader = Omit<TimelineTrack, "items" | "transitions">;

export async function trackSnapshotHeader(
  track: any,
  mediaType: TrackMediaType,
): Promise<TrackSnapshotHeader> {
  const index = Number(await track.getIndex());
  if (!Number.isInteger(index) || index < 0) {
    throw new Error("Premiere returned an invalid track index");
  }
  return {
    mediaType,
    index,
    id: Number(track.id),
    name: String(track.name || `${mediaType} ${index + 1}`),
    muted: Boolean(await track.isMuted()),
  };
}

export function timelineItemRef(
  mediaType: TrackMediaType,
  trackIndex: number,
  itemIndex: number,
): string {
  return `${mediaType}:${trackIndex}:${itemIndex}`;
}

export function timelineTransitionRef(
  mediaType: TrackMediaType,
  trackIndex: number,
  transitionIndex: number,
): string {
  return `${mediaType}-transition:${trackIndex}:${transitionIndex}`;
}
