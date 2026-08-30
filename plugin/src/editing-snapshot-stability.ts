export interface EditingSnapshotObservation {
  startProjectGuid: string;
  startSequenceGuid: string;
  endProjectGuid: string;
  endSequenceGuid: string;
  projectItemsProjectGuid: string;
  timelineProjectGuid: string;
  timelineSequenceGuid: string;
  projectItemsRevision: string;
  timelineRevision: string;
}

function hasIdentity(
  observation: EditingSnapshotObservation,
  projectGuid: string,
  sequenceGuid: string,
): boolean {
  return (
    observation.startProjectGuid === projectGuid &&
    observation.startSequenceGuid === sequenceGuid &&
    observation.endProjectGuid === projectGuid &&
    observation.endSequenceGuid === sequenceGuid &&
    observation.projectItemsProjectGuid === projectGuid &&
    observation.timelineProjectGuid === projectGuid &&
    observation.timelineSequenceGuid === sequenceGuid
  );
}

export function isStableEditingSnapshotPair(
  first: EditingSnapshotObservation,
  second: EditingSnapshotObservation,
): boolean {
  const projectGuid = first.startProjectGuid;
  const sequenceGuid = first.startSequenceGuid;
  return (
    hasIdentity(first, projectGuid, sequenceGuid) &&
    hasIdentity(second, projectGuid, sequenceGuid) &&
    first.projectItemsRevision === second.projectItemsRevision &&
    first.timelineRevision === second.timelineRevision
  );
}
