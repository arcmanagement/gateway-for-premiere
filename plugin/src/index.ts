import type { premierepro } from "@adobe/premierepro";
import type {
  CaptionTrackSnapshot,
  ComponentSnapshot,
  ConnectedSession,
  EditingSnapshot,
  PluginConnected,
  PluginRequest,
  PluginResponse,
  ProjectItemSnapshot,
  ProjectItemsSnapshot,
  TimelineItem,
  TimelineMarker,
  TimelineSnapshot,
  TimelineTrack,
  TimelineTransition,
} from "../../src/shared/protocol";
import { MUTATION_OPERATIONS } from "../../src/shared/protocol";
import {
  assertEffectInsertionIndex,
  assertRemovableEffectIndex,
} from "./effect-boundary";
import { readableComponentParam } from "./component-param-boundary";
import { snapshotComponentParam } from "./component-param-snapshot";
import { runMogrtMutation } from "./mogrt-mutation";
import { importedProjectItemsForPath } from "./project-item-delta";
import { projectItemsAtDepth } from "./project-items-projection";
import {
  isStableEditingSnapshotPair,
  type EditingSnapshotObservation,
} from "./editing-snapshot-stability";
import { timelineRevisionReliability } from "./timeline-reliability";
import {
  timelineItemRef,
  timelineTransitionRef,
  trackSnapshotHeader,
} from "./track-snapshot";
import {
  digestJournalValue,
  isMissingJournalEntryError,
  isRequestDeadlineExpiredError,
  isRequestUnknownOutcomeError,
  RequestJournal,
  RequestDeadlineExpiredError,
  RequestUnknownOutcomeError,
  type RequestJournalPersistence,
} from "./request-journal";

declare const __GATEWAY_PORT__: number;
declare const __GATEWAY_TOKEN__: string;
declare const __PLUGIN_VERSION__: string;
declare function require(name: string): any;

const ppro = require("premierepro") as premierepro;
const { entrypoints, host, storage } = require("uxp") as typeof import("uxp");
const localFileSystem = (
  storage as unknown as { localFileSystem: { getDataFolder(): Promise<any> } }
).localFileSystem;

const sessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
let socket: WebSocket | undefined;
let retryMs = 250;

class UxpRequestJournalPersistence implements RequestJournalPersistence {
  private folder: any;

  private async dataFolder(): Promise<any> {
    this.folder ||= await localFileSystem.getDataFolder();
    return this.folder;
  }

  async read(): Promise<string | null> {
    const folder = await this.dataFolder();
    try {
      const file = await folder.getEntry("request-journal-v1.json");
      return String(await file.read());
    } catch (error) {
      if (isMissingJournalEntryError(error)) return null;
      throw error;
    }
  }

  async write(value: string): Promise<void> {
    const folder = await this.dataFolder();
    const temporary = await folder.createFile("request-journal-v1.tmp", {
      overwrite: true,
    });
    await temporary.write(value);
    await temporary.moveTo(folder, {
      newName: "request-journal-v1.json",
      overwrite: true,
    });
  }
}

const requestJournal = new RequestJournal(new UxpRequestJournalPersistence());
let journalStatus: "ready" | "unavailable" = "unavailable";

async function ensureJournal(): Promise<void> {
  await requestJournal.initialize();
  journalStatus = "ready";
}

function setStatus(value: string): void {
  const element = document.getElementById("status");
  if (element) element.textContent = value;
}

function guid(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "toString" in value)
    return String(value);
  return "";
}

function seconds(value: unknown): number {
  if (value && typeof value === "object" && "seconds" in value) {
    return Number((value as { seconds: unknown }).seconds);
  }
  return Number(value || 0);
}

function hash(value: string): string {
  let result = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 0x01000193);
  }
  return (result >>> 0).toString(16).padStart(8, "0");
}

async function activeProject(): Promise<any> {
  const project = await ppro.Project.getActiveProject();
  if (!project) throw new Error("No active Premiere project");
  return project;
}

type TimelineContext = { project: any; sequence: any };

async function activeContext(): Promise<TimelineContext> {
  const project = await activeProject();
  const sequence = await project.getActiveSequence();
  if (!sequence) throw new Error("No active Premiere sequence");
  return { project, sequence };
}

async function sessionDescription(): Promise<ConnectedSession> {
  const session: ConnectedSession = {
    sessionId,
    pluginVersion: __PLUGIN_VERSION__,
    premiereVersion: String(host.version || ""),
    journalStatus,
    ...(journalStatus === "ready"
      ? { journalEntries: requestJournal.size }
      : {}),
  };
  try {
    const project = await activeProject();
    session.projectGuid = guid(project.guid);
    session.projectName = String(project.name || "");
    const sequence = await project.getActiveSequence();
    if (sequence) {
      session.sequenceGuid = guid(sequence.guid);
      session.sequenceName = String(sequence.name || "");
    }
  } catch {
    // A project can be opened after the Plugin connects.
  }
  return session;
}

async function serializeItem(
  item: any,
  mediaType: "video" | "audio",
  trackIndex: number,
  itemIndex: number,
): Promise<TimelineItem> {
  const projectItem = await item.getProjectItem();
  let componentsRevision = "unavailable";
  let componentsReliability: TimelineItem["componentsReliability"] = "complete";
  try {
    const components = await componentSnapshots(item);
    componentsRevision = hash(JSON.stringify(components));
    if (
      components.some((component) =>
        component.params.some(
          (param) => param.valueReliability === "unavailable",
        ),
      )
    ) {
      componentsReliability = "unavailable";
    }
  } catch {
    componentsReliability = "unavailable";
  }
  return {
    ref: timelineItemRef(mediaType, trackIndex, itemIndex),
    mediaType,
    trackIndex,
    itemIndex,
    name: String(await item.getName()),
    startSeconds: seconds(await item.getStartTime()),
    endSeconds: seconds(await item.getEndTime()),
    inPointSeconds: seconds(await item.getInPoint()),
    outPointSeconds: seconds(await item.getOutPoint()),
    disabled: Boolean(await item.isDisabled()),
    speed: Number(await item.getSpeed()),
    reversed: Boolean(await item.isSpeedReversed()),
    componentsRevision,
    componentsReliability,
    ...(projectItem
      ? { projectItemId: String(await projectItem.getId()) }
      : {}),
  };
}

async function serializeTransition(
  item: any,
  mediaType: "video" | "audio",
  trackIndex: number,
  transitionIndex: number,
): Promise<TimelineTransition> {
  return {
    ref: timelineTransitionRef(mediaType, trackIndex, transitionIndex),
    mediaType,
    trackIndex,
    transitionIndex,
    name: String(await item.getName()),
    matchName: String(await item.getMatchName()),
    startSeconds: seconds(await item.getStartTime()),
    endSeconds: seconds(await item.getEndTime()),
  };
}

async function sequenceMarkerSnapshots(
  sequence: any,
): Promise<TimelineMarker[]> {
  const owner = await ppro.Markers.getMarkers(sequence);
  const markers: TimelineMarker[] = owner.getMarkers().map((marker: any) => {
    const webLinkRevision = hash(
      JSON.stringify({
        url: String(marker.getUrl()),
        target: String(marker.getTarget()),
      }),
    );
    return {
      guid: guid(marker.guid),
      name: String(marker.getName()),
      type: String(marker.getType()),
      startSeconds: seconds(marker.getStart()),
      durationSeconds: seconds(marker.getDuration()),
      comments: String(marker.getComments()),
      colorIndex: Number(marker.getColorIndex()),
      webLinkRevision,
    };
  });
  return markers.sort(
    (left, right) =>
      left.startSeconds - right.startSeconds ||
      left.guid.localeCompare(right.guid),
  );
}

async function serializeTrack(
  sequence: any,
  mediaType: "video" | "audio",
  index: number,
): Promise<TimelineTrack> {
  const track =
    mediaType === "video"
      ? await sequence.getVideoTrack(index)
      : await sequence.getAudioTrack(index);
  const header = await trackSnapshotHeader(track, mediaType);
  const rawItems = await track.getTrackItems(
    ppro.Constants.TrackItemType.CLIP,
    false,
  );
  const items: TimelineItem[] = [];
  for (let itemIndex = 0; itemIndex < rawItems.length; itemIndex += 1) {
    items.push(
      await serializeItem(
        rawItems[itemIndex],
        mediaType,
        header.index,
        itemIndex,
      ),
    );
  }
  const rawTransitions = await track.getTrackItems(
    ppro.Constants.TrackItemType.TRANSITION,
    false,
  );
  const transitions: TimelineTransition[] = [];
  for (
    let transitionIndex = 0;
    transitionIndex < rawTransitions.length;
    transitionIndex += 1
  ) {
    if (!rawTransitions[transitionIndex]) {
      // Premiere 26.3 exposes an opaque null slot for some applied transitions.
      // Keep the slot in the snapshot so optimistic revisions still detect it.
      transitions.push({
        ref: timelineTransitionRef(mediaType, header.index, transitionIndex),
        mediaType,
        trackIndex: header.index,
        transitionIndex,
        name: null,
        matchName: null,
        startSeconds: null,
        endSeconds: null,
      });
      continue;
    }
    transitions.push(
      await serializeTransition(
        rawTransitions[transitionIndex],
        mediaType,
        header.index,
        transitionIndex,
      ),
    );
  }
  return {
    ...header,
    items,
    transitions,
  };
}

async function serializeCaptionTrack(
  sequence: any,
  index: number,
): Promise<CaptionTrackSnapshot> {
  const track = await sequence.getCaptionTrack(index);
  let itemCount: number | null = null;
  let itemsReliability: CaptionTrackSnapshot["itemsReliability"] =
    "unavailable";
  try {
    const items = track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false);
    if (Array.isArray(items)) {
      itemCount = items.length;
      itemsReliability = "count-only";
    }
  } catch {
    // Premiere publishes CaptionTrack items without a public item shape.
  }
  return {
    index: Number(await track.getIndex()),
    id: Number(track.id),
    name: String(track.name || `caption ${index + 1}`),
    muted: Boolean(await track.isMuted()),
    mediaTypeGuid: guid(await track.getMediaType()),
    itemCount,
    itemsReliability,
  };
}

async function timelineSnapshot(
  context?: TimelineContext,
): Promise<TimelineSnapshot> {
  const { project, sequence } = context || (await activeContext());
  const tracks: TimelineTrack[] = [];
  const captionTracks: CaptionTrackSnapshot[] = [];
  const videoCount = await sequence.getVideoTrackCount();
  const audioCount = await sequence.getAudioTrackCount();
  const captionCount = await sequence.getCaptionTrackCount();
  for (let index = 0; index < videoCount; index += 1) {
    tracks.push(await serializeTrack(sequence, "video", index));
  }
  for (let index = 0; index < audioCount; index += 1) {
    tracks.push(await serializeTrack(sequence, "audio", index));
  }
  for (let index = 0; index < captionCount; index += 1) {
    captionTracks.push(await serializeCaptionTrack(sequence, index));
  }
  const hasOpaqueTransitions = tracks.some((track) =>
    track.transitions.some((transition) => transition.matchName === null),
  );
  const hasIncompleteComponents = tracks.some((track) =>
    track.items.some((item) => item.componentsReliability !== "complete"),
  );
  const hasOpaqueCaptions = captionTracks.some(
    (track) => track.itemCount === null || track.itemCount > 0,
  );
  const revisionReliability = timelineRevisionReliability({
    hasOpaqueTransitions,
    hasIncompleteComponents,
    hasOpaqueCaptions,
  });
  const snapshot = {
    project: {
      guid: guid(project.guid),
      name: String(project.name || ""),
      path: String(project.path || ""),
    },
    sequence: {
      guid: guid(sequence.guid),
      name: String(sequence.name || ""),
    },
    tracks,
    captionTracks,
    markers: await sequenceMarkerSnapshots(sequence),
    revisionReliability,
  };
  return { ...snapshot, revision: hash(JSON.stringify(snapshot)) };
}

function sequenceMarkerType(value: unknown): string {
  const requested = String(value || "comment").toLowerCase();
  const types: Record<string, string> = {
    comment: ppro.Marker.MARKER_TYPE_COMMENT,
    chapter: ppro.Marker.MARKER_TYPE_CHAPTER,
    weblink: ppro.Marker.MARKER_TYPE_WEBLINK,
    "flv-cue-point": ppro.Marker.MARKER_TYPE_FLVCUEPOINT,
  };
  const markerType = types[requested];
  if (!markerType) {
    throw new Error(
      "markerType must be comment, chapter, weblink, or flv-cue-point",
    );
  }
  return markerType;
}

async function sequenceMarkerContext(
  payload: Record<string, unknown>,
): Promise<{
  before: TimelineSnapshot;
  project: any;
  sequence: any;
  owner: any;
  marker: any;
}> {
  const context = await timelineMutationContext(payload);
  const owner = await ppro.Markers.getMarkers(context.sequence);
  const requestedGuid = String(payload.markerGuid || "");
  const marker = owner
    .getMarkers()
    .find((candidate: any) => guid(candidate.guid) === requestedGuid);
  if (!marker) throw new Error("Sequence marker not found");
  return { ...context, owner, marker };
}

async function addSequenceMarker(
  payload: Record<string, unknown>,
): Promise<{ timeline: TimelineSnapshot }> {
  if (payload.confirm !== true)
    throw new Error("add_sequence_marker requires confirm: true");
  const { before, project, sequence } = await timelineMutationContext(payload);
  const name = String(payload.name || "");
  if (!name) throw new Error("Marker name is required");
  const timeSeconds = finiteNumber(payload.timeSeconds, "timeSeconds");
  const durationSeconds = finiteNumber(
    payload.durationSeconds ?? 0,
    "durationSeconds",
  );
  if (timeSeconds < 0 || durationSeconds < 0)
    throw new Error("Marker time and duration must be >= 0");
  const markerType = sequenceMarkerType(payload.markerType);
  const owner = await ppro.Markers.getMarkers(sequence);
  await execute(before, payload, project, "add sequence marker", (action) => {
    action.addAction(
      owner.createAddMarkerAction(
        name,
        markerType,
        ppro.TickTime.createWithSeconds(timeSeconds),
        ppro.TickTime.createWithSeconds(durationSeconds),
        String(payload.comments || ""),
      ),
    );
  });
  return { timeline: await timelineSnapshot({ project, sequence }) };
}

async function updateSequenceMarker(
  payload: Record<string, unknown>,
): Promise<{ timeline: TimelineSnapshot }> {
  if (payload.confirm !== true)
    throw new Error("update_sequence_marker requires confirm: true");
  const { before, project, sequence, marker } =
    await sequenceMarkerContext(payload);
  const hasName = payload.name !== undefined;
  const hasComments = payload.comments !== undefined;
  const hasDuration = payload.durationSeconds !== undefined;
  const hasType = payload.markerType !== undefined;
  const hasColor = payload.colorIndex !== undefined;
  if (!hasName && !hasComments && !hasDuration && !hasType && !hasColor)
    throw new Error("Marker update requires a changed field");
  const durationSeconds = hasDuration
    ? finiteNumber(payload.durationSeconds, "durationSeconds")
    : undefined;
  if (durationSeconds !== undefined && durationSeconds < 0)
    throw new Error("Marker duration must be >= 0");
  const colorIndex = hasColor
    ? integer(payload.colorIndex, "colorIndex", 0)
    : undefined;
  if (colorIndex !== undefined && colorIndex > 6)
    throw new Error("colorIndex must be from 0 to 6");
  const markerType = hasType
    ? sequenceMarkerType(payload.markerType)
    : undefined;
  await execute(
    before,
    payload,
    project,
    "update sequence marker",
    (action) => {
      if (hasName)
        action.addAction(marker.createSetNameAction(String(payload.name)));
      if (hasComments) {
        action.addAction(
          marker.createSetCommentsAction(String(payload.comments)),
        );
      }
      if (durationSeconds !== undefined) {
        action.addAction(
          marker.createSetDurationAction(
            ppro.TickTime.createWithSeconds(durationSeconds),
          ),
        );
      }
      if (markerType !== undefined)
        action.addAction(marker.createSetTypeAction(markerType));
      if (colorIndex !== undefined)
        action.addAction(marker.createSetColorByIndexAction(colorIndex));
    },
  );
  return { timeline: await timelineSnapshot({ project, sequence }) };
}

async function moveSequenceMarker(
  payload: Record<string, unknown>,
): Promise<{ timeline: TimelineSnapshot }> {
  if (payload.confirm !== true)
    throw new Error("move_sequence_marker requires confirm: true");
  const { before, project, sequence, owner, marker } =
    await sequenceMarkerContext(payload);
  const timeSeconds = finiteNumber(payload.timeSeconds, "timeSeconds");
  if (timeSeconds < 0) throw new Error("Marker time must be >= 0");
  await execute(before, payload, project, "move sequence marker", (action) => {
    action.addAction(
      owner.createMoveMarkerAction(
        marker,
        ppro.TickTime.createWithSeconds(timeSeconds),
      ),
    );
  });
  return { timeline: await timelineSnapshot({ project, sequence }) };
}

async function removeSequenceMarker(
  payload: Record<string, unknown>,
): Promise<{ timeline: TimelineSnapshot }> {
  if (payload.confirm !== true)
    throw new Error("remove_sequence_marker requires confirm: true");
  const { before, project, sequence, owner, marker } =
    await sequenceMarkerContext(payload);
  await execute(
    before,
    payload,
    project,
    "remove sequence marker",
    (action) => {
      action.addAction(owner.createRemoveMarkerAction(marker));
    },
  );
  return { timeline: await timelineSnapshot({ project, sequence }) };
}

function integer(value: unknown, label: string, minimum = 0): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum)
    throw new Error(`${label} must be an integer >= ${minimum}`);
  return parsed;
}

function finiteNumber(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a number`);
  return parsed;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}

const REQUEST_DEADLINE_KEY = "__gatewayRequestDeadlineEpochMs";
const REQUEST_CONNECTION_KEY = "__gatewayRequestConnectionOpen";

function assertRequestActive(payload: Record<string, unknown>): void {
  const deadline = Number(payload[REQUEST_DEADLINE_KEY]);
  if (!Number.isFinite(deadline) || Date.now() >= deadline) {
    throw new RequestDeadlineExpiredError();
  }
  const connectionOpen = payload[REQUEST_CONNECTION_KEY];
  if (
    typeof connectionOpen !== "function" ||
    !(connectionOpen as () => boolean)()
  ) {
    throw new Error("Gateway for Premiere connection closed before execution");
  }
}

async function assertMutationBoundary(
  snapshot: TimelineSnapshot,
  payload: Record<string, unknown>,
): Promise<void> {
  assertRequestActive(payload);
  const current = await activeContext();
  if (
    guid(current.project.guid) !== snapshot.project.guid ||
    guid(current.sequence.guid) !== snapshot.sequence.guid
  ) {
    throw new Error("Active project or sequence changed; take a new snapshot");
  }
  const currentSnapshot = await timelineSnapshot(current);
  if (currentSnapshot.revision !== snapshot.revision) {
    throw new Error(
      "Timeline changed while preparing the operation; take a new snapshot",
    );
  }
  assertRequestActive(payload);
  const finalIdentity = await activeContext();
  if (
    guid(finalIdentity.project.guid) !== snapshot.project.guid ||
    guid(finalIdentity.sequence.guid) !== snapshot.sequence.guid
  ) {
    throw new Error("Active project or sequence changed; take a new snapshot");
  }
  assertRequestActive(payload);
}

async function execute(
  snapshot: TimelineSnapshot,
  payload: Record<string, unknown>,
  project: any,
  label: string,
  callback: (compoundAction: any) => void,
): Promise<void> {
  await assertMutationBoundary(snapshot, payload);
  let success = false;
  project.lockedAccess(() => {
    success = project.executeTransaction(
      callback,
      `Gateway for Premiere: ${label}`,
    );
  });
  if (!success) throw new Error(`Premiere rejected the ${label} transaction`);
}

function projectItemKind(type: number): ProjectItemSnapshot["kind"] {
  if (type === ppro.ProjectItem.TYPE_BIN || type === ppro.ProjectItem.TYPE_ROOT)
    return "bin";
  if (type === ppro.ProjectItem.TYPE_CLIP) return "clip";
  if (type === ppro.ProjectItem.TYPE_FILE) return "file";
  return "other";
}

async function serializeProjectItem(
  item: any,
  depth: number,
  maxDepth: number,
): Promise<ProjectItemSnapshot> {
  const id = String(await item.getId());
  let kind = projectItemKind(Number(item.type));
  const result: ProjectItemSnapshot = {
    id,
    name: String(item.name || ""),
    type: Number(item.type),
    kind,
  };
  if (kind === "bin") {
    if (depth < maxDepth) {
      const folder = ppro.FolderItem.cast(item);
      const children = await folder.getItems();
      result.children = [];
      for (const child of children) {
        result.children.push(
          await serializeProjectItem(child, depth + 1, maxDepth),
        );
      }
    }
    return result;
  }
  if (kind === "clip") {
    const clip = ppro.ClipProjectItem.cast(item);
    try {
      if (await clip.isSequence()) {
        kind = "sequence";
        result.kind = kind;
      } else {
        const mediaPath = await clip.getMediaFilePath();
        if (mediaPath) result.mediaPath = String(mediaPath);
      }
    } catch {
      // Some generated project items do not expose a filesystem path.
    }
  }
  return result;
}

async function projectItems(
  payload: Record<string, unknown>,
  requestedProject?: any,
): Promise<ProjectItemsSnapshot> {
  const project = requestedProject || (await activeProject());
  const maxDepth = integer(payload.maxDepth ?? 8, "maxDepth", 0);
  if (maxDepth > 32) throw new Error("maxDepth must be <= 32");
  const full = await fullProjectItems(project);
  return {
    projectGuid: full.projectGuid,
    revision: full.revision,
    items: projectItemsAtDepth(full.items, maxDepth),
  };
}

async function fullProjectItems(project: any): Promise<{
  projectGuid: string;
  revision: string;
  items: ProjectItemSnapshot[];
}> {
  const root = await project.getRootItem();
  const children = await root.getItems();
  const items: ProjectItemSnapshot[] = [];
  for (const child of children) {
    items.push(await serializeProjectItem(child, 0, 32));
  }
  return {
    projectGuid: guid(project.guid),
    revision: hash(JSON.stringify(items)),
    items,
  };
}

interface EditingSnapshotRead {
  observation: EditingSnapshotObservation;
  projectItems: ProjectItemsSnapshot;
  timeline: TimelineSnapshot;
}

async function editingSnapshotRead(
  payload: Record<string, unknown>,
): Promise<EditingSnapshotRead> {
  assertRequestActive(payload);
  const start = await activeContext();
  const startProjectGuid = guid(start.project.guid);
  const startSequenceGuid = guid(start.sequence.guid);
  const items = await projectItems(payload, start.project);
  const timeline = await timelineSnapshot(start);
  assertRequestActive(payload);
  const end = await activeContext();
  return {
    observation: {
      startProjectGuid,
      startSequenceGuid,
      endProjectGuid: guid(end.project.guid),
      endSequenceGuid: guid(end.sequence.guid),
      projectItemsProjectGuid: items.projectGuid,
      timelineProjectGuid: timeline.project.guid,
      timelineSequenceGuid: timeline.sequence.guid,
      projectItemsRevision: items.revision,
      timelineRevision: timeline.revision,
    },
    projectItems: items,
    timeline,
  };
}

async function editingSnapshot(
  payload: Record<string, unknown>,
): Promise<EditingSnapshot> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const first = await editingSnapshotRead(payload);
    const second = await editingSnapshotRead(payload);
    if (isStableEditingSnapshotPair(first.observation, second.observation)) {
      return {
        capturedAtEpochMs: Date.now(),
        stability: "stable",
        projectItems: second.projectItems,
        timeline: second.timeline,
      };
    }
  }
  throw new Error(
    "Premiere editing state did not remain stable; take the snapshot again",
  );
}

async function findProjectItemContext(
  folder: any,
  requestedId: string,
): Promise<{ item: any; parent: any } | undefined> {
  const items = await folder.getItems();
  for (const item of items) {
    if (String(await item.getId()) === requestedId) {
      return { item, parent: folder };
    }
    if (
      item.type === ppro.ProjectItem.TYPE_BIN ||
      item.type === ppro.ProjectItem.TYPE_ROOT
    ) {
      const nested = await findProjectItemContext(
        ppro.FolderItem.cast(item),
        requestedId,
      );
      if (nested) return nested;
    }
  }
  return undefined;
}

async function sequencesUsingProjectItem(
  project: any,
  projectItemId: string,
): Promise<string[]> {
  const usedBy: string[] = [];
  for (const sequence of await project.getSequences()) {
    let found = false;
    const trackCounts = [
      {
        count: await sequence.getVideoTrackCount(),
        getTrack: (index: number) => sequence.getVideoTrack(index),
      },
      {
        count: await sequence.getAudioTrackCount(),
        getTrack: (index: number) => sequence.getAudioTrack(index),
      },
    ];
    for (const trackGroup of trackCounts) {
      for (let index = 0; index < trackGroup.count && !found; index += 1) {
        const track = await trackGroup.getTrack(index);
        const items = await track.getTrackItems(
          ppro.Constants.TrackItemType.CLIP,
          false,
        );
        for (const item of items) {
          const projectItem = await item.getProjectItem();
          if (
            projectItem &&
            String(await projectItem.getId()) === projectItemId
          ) {
            found = true;
            break;
          }
        }
      }
    }
    if (found) usedBy.push(guid(sequence.guid));
  }
  return usedBy;
}

async function findProjectItem(
  folder: any,
  requestedId: string,
): Promise<any | undefined> {
  const items = await folder.getItems();
  for (const item of items) {
    if (String(await item.getId()) === requestedId) return item;
    if (
      item.type === ppro.ProjectItem.TYPE_BIN ||
      item.type === ppro.ProjectItem.TYPE_ROOT
    ) {
      const nested = await findProjectItem(
        ppro.FolderItem.cast(item),
        requestedId,
      );
      if (nested) return nested;
    }
  }
  return undefined;
}

async function projectItemDetails(
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const project = await activeProject();
  const item = await findProjectItem(
    await project.getRootItem(),
    String(payload.projectItemId || ""),
  );
  if (!item) throw new Error("Project item not found");
  const parent = await item.getParentBin();
  const details: Record<string, unknown> = {
    id: String(await item.getId()),
    name: String(item.name || ""),
    type: Number(item.type),
    colorLabelIndex: Number(await item.getColorLabelIndex()),
    ...(parent ? { parentId: String(await parent.getId()) } : {}),
  };
  if (item.type !== ppro.ProjectItem.TYPE_CLIP) return details;
  const clip = ppro.ClipProjectItem.cast(item);
  const isSequence = Boolean(await clip.isSequence());
  details.isSequence = isSequence;
  details.contentType = Number(await clip.getContentType());
  details.inputLutId = String(await clip.getInputLUTID());
  details.embeddedLutId = String(await clip.getEmbeddedLUTID());
  details.mergedClip = Boolean(await clip.isMergedClip());
  details.multicamClip = Boolean(await clip.isMulticamClip());
  details.originatingProjectPath = String(
    await clip.getOriginatingProjectPath(),
  );
  if (!isSequence) {
    details.canChangeMediaPath = Boolean(await clip.canChangeMediaPath());
    details.offline = Boolean(await clip.isOffline());
    details.canProxy = Boolean(await clip.canProxy());
    details.hasProxy = Boolean(await clip.hasProxy());
    details.proxyPath = String(await clip.getProxyPath());
    details.mediaPath = String(await clip.getMediaFilePath());
    const interpretation = await clip.getFootageInterpretation();
    details.footageInterpretation = {
      frameRate: Number(interpretation.getFrameRate()),
      pixelAspectRatio: Number(interpretation.getPixelAspectRatio()),
      fieldType: Number(interpretation.getFieldType()),
      removePullDown: Boolean(interpretation.getRemovePullDown()),
      alphaUsage: Number(interpretation.getAlphaUsage()),
      ignoreAlpha: Boolean(interpretation.getIgnoreAlpha()),
      invertAlpha: Boolean(interpretation.getInvertAlpha()),
      vrConform: Number(interpretation.getVrConform()),
      vrLayout: Number(interpretation.getVrLayout()),
      vrHorizontalView: Number(interpretation.getVrHorzView()),
      vrVerticalView: Number(interpretation.getVrVertView()),
      inputLutId: String(interpretation.getInputLUTID()),
    };
  }
  return details;
}

async function findProjectItemsByMediaPath(
  payload: Record<string, unknown>,
): Promise<ProjectItemSnapshot[]> {
  const project = await activeProject();
  const root = await project.getRootItem();
  const seed = await findProjectItem(root, String(payload.projectItemId || ""));
  if (!seed || seed.type !== ppro.ProjectItem.TYPE_CLIP)
    throw new Error("A clip project item is required");
  const match = String(payload.match || "");
  if (!match) throw new Error("Media path match is required");
  const matches = await ppro.ClipProjectItem.cast(
    seed,
  ).findItemsMatchingMediaPath(match, payload.ignoreSubclips !== false);
  return Promise.all(
    matches.map((item: any) => serializeProjectItem(item, 0, 0)),
  );
}

async function checkedProjectItemMutation(
  payload: Record<string, unknown>,
): Promise<{
  before: TimelineSnapshot;
  project: any;
  item: any;
  parent: any;
}> {
  const { before, project } = await timelineMutationContext(payload);
  const items = await fullProjectItems(project);
  if (String(payload.expectedProjectItemsRevision || "") !== items.revision) {
    throw new Error("Project items changed; read them again");
  }
  const context = await findProjectItemContext(
    await project.getRootItem(),
    String(payload.projectItemId || ""),
  );
  if (!context) throw new Error("Project item not found");
  await assertMutationBoundary(before, payload);
  return { before, project, ...context };
}

async function createBin(
  payload: Record<string, unknown>,
  smart: boolean,
): Promise<Record<string, unknown>> {
  if (payload.confirm !== true)
    throw new Error(
      `${smart ? "create_smart_bin" : "create_bin"} requires confirm: true`,
    );
  const { before, project } = await timelineMutationContext(payload);
  const items = await fullProjectItems(project);
  if (String(payload.expectedProjectItemsRevision || "") !== items.revision) {
    throw new Error("Project items changed; read them again");
  }
  const root = await project.getRootItem();
  const parentItem = payload.parentBinId
    ? await findProjectItem(root, String(payload.parentBinId))
    : root;
  if (
    !parentItem ||
    (parentItem.type !== ppro.ProjectItem.TYPE_BIN &&
      parentItem.type !== ppro.ProjectItem.TYPE_ROOT)
  ) {
    throw new Error("Parent bin not found");
  }
  const parent = ppro.FolderItem.cast(parentItem);
  const name = String(payload.name || "").trim();
  if (!name) throw new Error("Bin name is required");
  await execute(
    before,
    payload,
    project,
    smart ? "create smart bin" : "create bin",
    (action) => {
      action.addAction(
        smart
          ? parent.createSmartBinAction(name, String(payload.searchQuery || ""))
          : parent.createBinAction(name, payload.makeUnique !== false),
      );
    },
  );
  return { projectItems: await fullProjectItems(project) };
}

async function updateProjectItem(
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (payload.confirm !== true)
    throw new Error("update_project_item requires confirm: true");
  const { before, project, item } = await checkedProjectItemMutation(payload);
  if (payload.name === undefined && payload.colorLabelIndex === undefined)
    throw new Error("Project item name or colorLabelIndex is required");
  await execute(before, payload, project, "update project item", (action) => {
    if (payload.name !== undefined) {
      const name = String(payload.name).trim();
      if (!name) throw new Error("Project item name cannot be empty");
      action.addAction(item.createSetNameAction(name));
    }
    if (payload.colorLabelIndex !== undefined) {
      action.addAction(
        item.createSetColorLabelAction(
          integer(payload.colorLabelIndex, "colorLabelIndex"),
        ),
      );
    }
  });
  return { projectItems: await fullProjectItems(project) };
}

async function moveProjectItem(
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (payload.confirm !== true)
    throw new Error("move_project_item requires confirm: true");
  const { before, project, item, parent } =
    await checkedProjectItemMutation(payload);
  const target = await findProjectItem(
    await project.getRootItem(),
    String(payload.targetBinId || ""),
  );
  if (
    !target ||
    (target.type !== ppro.ProjectItem.TYPE_BIN &&
      target.type !== ppro.ProjectItem.TYPE_ROOT)
  ) {
    throw new Error("Target bin not found");
  }
  await execute(before, payload, project, "move project item", (action) => {
    action.addAction(
      parent.createMoveItemAction(item, ppro.FolderItem.cast(target)),
    );
  });
  return { projectItems: await fullProjectItems(project) };
}

async function checkedClipMutation(payload: Record<string, unknown>): Promise<{
  before: TimelineSnapshot;
  project: any;
  clip: any;
}> {
  const { before, project, item } = await checkedProjectItemMutation(payload);
  if (item.type !== ppro.ProjectItem.TYPE_CLIP)
    throw new Error("A clip project item is required");
  const clip = ppro.ClipProjectItem.cast(item);
  if (await clip.isSequence())
    throw new Error("A media clip project item is required");
  return { before, project, clip };
}

async function updateClipMedia(
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (payload.confirm !== true)
    throw new Error("update_clip_media requires confirm: true");
  const { before, project, clip } = await checkedClipMutation(payload);
  const action = String(payload.action || "");
  if (action === "offline" || action === "scale-to-frame") {
    await execute(before, payload, project, action, (compoundAction) => {
      compoundAction.addAction(
        action === "offline"
          ? clip.createSetOfflineAction()
          : clip.createSetScaleToFrameSizeAction(),
      );
    });
  } else {
    await assertMutationBoundary(before, payload);
    let success = false;
    if (action === "refresh") success = await clip.refreshMedia();
    else if (action === "attach-proxy" || action === "attach-hires") {
      success = await clip.attachProxy(
        String(payload.mediaPath || ""),
        action === "attach-hires",
        payload.makeAlternateLinkInTeamProjects === true,
      );
    } else if (action === "relink") {
      success = await clip.changeMediaFilePath(
        String(payload.mediaPath || ""),
        payload.overrideCompatibilityCheck === true,
      );
    } else {
      throw new Error(
        "action must be offline, refresh, attach-proxy, attach-hires, relink, or scale-to-frame",
      );
    }
    if (!success) throw new Error(`Premiere rejected clip media ${action}`);
  }
  return projectItemDetails({ projectItemId: payload.projectItemId });
}

async function createSubclip(
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (payload.confirm !== true)
    throw new Error("create_subclip requires confirm: true");
  const { before, project, clip } = await checkedClipMutation(payload);
  const name = String(payload.name || "").trim();
  if (!name) throw new Error("Subclip name is required");
  const start = finiteNumber(payload.startSeconds, "startSeconds");
  const end = finiteNumber(payload.endSeconds, "endSeconds");
  if (start < 0 || end <= start)
    throw new Error("Subclip bounds must satisfy 0 <= start < end");
  await execute(before, payload, project, "create subclip", (action) => {
    action.addAction(
      clip.createSubClipAction(
        name,
        ppro.TickTime.createWithSeconds(start),
        ppro.TickTime.createWithSeconds(end),
        payload.hardBoundaries !== false,
        {
          takeVideo: payload.takeVideo !== false,
          takeAudio: payload.takeAudio !== false,
        },
      ),
    );
  });
  return { projectItems: await fullProjectItems(project) };
}

async function setClipInterpretation(
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (payload.confirm !== true)
    throw new Error("set_clip_interpretation requires confirm: true");
  const { before, project, clip } = await checkedClipMutation(payload);
  const changes = payload.interpretation;
  if (!changes || typeof changes !== "object" || Array.isArray(changes))
    throw new Error("interpretation must be an object");
  const values = changes as Record<string, unknown>;
  const interpretation = await clip.getFootageInterpretation();
  const setters: Record<string, (value: unknown) => boolean> = {
    frameRate: (value) =>
      interpretation.setFrameRate(finiteNumber(value, "frameRate")),
    pixelAspectRatio: (value) =>
      interpretation.setPixelAspectRatio(
        finiteNumber(value, "pixelAspectRatio"),
      ),
    fieldType: (value) =>
      interpretation.setFieldType(integer(value, "fieldType")),
    removePullDown: (value) =>
      interpretation.setRemovePullDown(booleanValue(value, "removePullDown")),
    alphaUsage: (value) =>
      interpretation.setAlphaUsage(integer(value, "alphaUsage")),
    ignoreAlpha: (value) =>
      interpretation.setIgnoreAlpha(booleanValue(value, "ignoreAlpha")),
    invertAlpha: (value) =>
      interpretation.setInvertAlpha(booleanValue(value, "invertAlpha")),
    vrConform: (value) =>
      interpretation.setVrConform(integer(value, "vrConform")),
    vrLayout: (value) => interpretation.setVrLayout(integer(value, "vrLayout")),
    vrHorizontalView: (value) =>
      interpretation.setVrHorzView(finiteNumber(value, "vrHorizontalView")),
    vrVerticalView: (value) =>
      interpretation.setVrVertView(finiteNumber(value, "vrVerticalView")),
    inputLutId: (value) => interpretation.setInputLUTID(String(value)),
  };
  const unknown = Object.keys(values).find((key) => !setters[key]);
  if (unknown)
    throw new Error(`Unsupported footage interpretation: ${unknown}`);
  if (Object.keys(values).length === 0)
    throw new Error("At least one footage interpretation value is required");
  for (const [key, value] of Object.entries(values)) {
    if (!setters[key]!(value))
      throw new Error(`Premiere rejected footage interpretation ${key}`);
  }
  await execute(
    before,
    payload,
    project,
    "set clip interpretation",
    (action) => {
      action.addAction(
        clip.createSetFootageInterpretationAction(interpretation),
      );
    },
  );
  return projectItemDetails({ projectItemId: payload.projectItemId });
}

async function setClipBounds(
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (payload.confirm !== true)
    throw new Error("set_clip_bounds requires confirm: true");
  const { before, project, clip } = await checkedClipMutation(payload);
  await execute(before, payload, project, "set clip bounds", (action) => {
    if (payload.clear === true) {
      action.addAction(clip.createClearInOutPointsAction());
      return;
    }
    const start = finiteNumber(payload.inSeconds, "inSeconds");
    const end = finiteNumber(payload.outSeconds, "outSeconds");
    if (start < 0 || end <= start)
      throw new Error("Clip bounds must satisfy 0 <= in < out");
    action.addAction(
      clip.createSetInOutPointsAction(
        ppro.TickTime.createWithSeconds(start),
        ppro.TickTime.createWithSeconds(end),
      ),
    );
  });
  return projectItemDetails({ projectItemId: payload.projectItemId });
}

async function sourceMonitorSnapshot(): Promise<Record<string, unknown>> {
  let item: any;
  try {
    item = await ppro.SourceMonitor.getProjectItem();
  } catch {
    item = undefined;
  }
  let positionSeconds: number | null = null;
  try {
    positionSeconds = seconds(await ppro.SourceMonitor.getPosition());
  } catch {
    // No open Source Monitor item has no meaningful position.
  }
  return {
    positionSeconds,
    ...(item
      ? {
          projectItem: {
            id: String(await item.getId()),
            name: String(item.name || ""),
            type: Number(item.type),
          },
        }
      : { projectItem: null }),
  };
}

async function sourceMonitorMutation(
  operation: "open-file" | "open-item" | "close" | "position" | "play",
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (payload.confirm !== true)
    throw new Error(`source_monitor_${operation} requires confirm: true`);
  const { before, project } = await timelineMutationContext(payload);
  const projectItem =
    operation === "open-item"
      ? await findProjectItem(
          await project.getRootItem(),
          String(payload.projectItemId || ""),
        )
      : undefined;
  if (operation === "open-item" && !projectItem) {
    throw new Error("Project item not found");
  }
  await assertMutationBoundary(before, payload);
  let success = false;
  if (operation === "open-file") {
    success = await ppro.SourceMonitor.openFilePath(
      String(payload.filePath || ""),
    );
  } else if (operation === "open-item") {
    success = await ppro.SourceMonitor.openProjectItem(projectItem);
  } else if (operation === "close") {
    success =
      payload.all === true
        ? await ppro.SourceMonitor.closeAllClips()
        : await ppro.SourceMonitor.closeClip();
  } else if (operation === "position") {
    const value = finiteNumber(payload.timeSeconds, "timeSeconds");
    if (value < 0) throw new Error("timeSeconds must be >= 0");
    success = await ppro.SourceMonitor.setPosition(
      ppro.TickTime.createWithSeconds(value),
    );
  } else {
    success = await ppro.SourceMonitor.play(
      finiteNumber(payload.speed ?? 1, "speed"),
    );
  }
  if (!success)
    throw new Error(`Premiere rejected Source Monitor ${operation}`);
  return sourceMonitorSnapshot();
}

async function clipTranscript(
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const project = await activeProject();
  const item = await findProjectItem(
    await project.getRootItem(),
    String(payload.projectItemId || ""),
  );
  if (!item || item.type !== ppro.ProjectItem.TYPE_CLIP)
    throw new Error("A clip project item is required");
  const clip = ppro.ClipProjectItem.cast(item);
  const available = Boolean(ppro.Transcript.hasTranscript(clip));
  return {
    available,
    ...(available
      ? { transcript: await ppro.Transcript.exportToJSON(clip) }
      : {}),
  };
}

async function importClipTranscript(
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (payload.confirm !== true)
    throw new Error("import_clip_transcript requires confirm: true");
  const { before, project, clip } = await checkedClipMutation(payload);
  const json = String(payload.transcript || "");
  if (!json) throw new Error("Transcript JSON is required");
  const segments = ppro.Transcript.importFromJSON(json);
  await execute(
    before,
    payload,
    project,
    "import clip transcript",
    (action) => {
      action.addAction(
        ppro.Transcript.createImportTextSegmentsAction(segments, clip),
      );
    },
  );
  if (!ppro.Transcript.hasTranscript(clip)) {
    throw new RequestUnknownOutcomeError(
      "Transcript import completed, but no transcript was found",
    );
  }
  return clipTranscript({ projectItemId: payload.projectItemId });
}

async function assertRemovableProjectItem(item: any): Promise<void> {
  if (item.type === ppro.ProjectItem.TYPE_ROOT) {
    throw new Error("The project root cannot be removed");
  }
  if (item.type === ppro.ProjectItem.TYPE_BIN) {
    const children = await ppro.FolderItem.cast(item).getItems();
    if (children.length > 0) {
      throw new Error("Only empty bins can be removed");
    }
    return;
  }
  if (
    item.type === ppro.ProjectItem.TYPE_CLIP &&
    (await ppro.ClipProjectItem.cast(item).isSequence())
  ) {
    throw new Error("Sequence project items cannot be removed");
  }
}

async function importMediaFile(payload: Record<string, unknown>): Promise<{
  projectItems: Awaited<ReturnType<typeof fullProjectItems>>;
  importedItems: ProjectItemSnapshot[];
}> {
  if (payload.confirm !== true)
    throw new Error("import_media_file requires confirm: true");
  const { before, project } = await timelineMutationContext(payload);
  const currentItems = await fullProjectItems(project);
  if (
    String(payload.expectedProjectItemsRevision || "") !== currentItems.revision
  ) {
    throw new Error("Project items changed; read them again");
  }
  const inputFile = String(payload.inputFile || "");
  if (!inputFile.startsWith("/"))
    throw new Error("Imported media path must be absolute");
  if (inputFile.toLowerCase().endsWith(".prproj"))
    throw new Error("Media import does not accept Premiere project files");
  await assertMutationBoundary(before, payload);
  const root = await project.getRootItem();
  const boundaryItems = await fullProjectItems(project);
  if (
    String(payload.expectedProjectItemsRevision || "") !==
    boundaryItems.revision
  ) {
    throw new Error("Project items changed while preparing the import");
  }
  // Recheck the active identity and timeline after the project-item walk. There
  // must be no asynchronous preparation between this boundary and importFiles.
  await assertMutationBoundary(before, payload);
  let imported: boolean | undefined;
  let importError: unknown;
  try {
    imported = await project.importFiles([inputFile], true, root, false);
  } catch (error) {
    importError = error;
  }
  // The non-transactional import has started. Do not classify a late deadline or
  // disconnected client as failure: establish the outcome from project state.
  let nextItems: Awaited<ReturnType<typeof fullProjectItems>>;
  try {
    nextItems = await fullProjectItems(project);
  } catch {
    throw new RequestUnknownOutcomeError(
      "Media import started, but its project-item outcome could not be read",
    );
  }
  const importedItems = importedProjectItemsForPath(
    boundaryItems.items,
    nextItems.items,
    inputFile,
  );
  if (importedItems.length === 0) {
    if (importError || imported) {
      throw new RequestUnknownOutcomeError(
        "Media import outcome could not be confirmed from project items",
        nextItems.revision,
      );
    }
    throw new Error("Premiere did not import the media file");
  }
  return { projectItems: nextItems, importedItems };
}

async function removeProjectItem(payload: Record<string, unknown>): Promise<{
  projectItems: Awaited<ReturnType<typeof fullProjectItems>>;
}> {
  if (payload.confirm !== true)
    throw new Error("remove_project_item requires confirm: true");
  const { before, project } = await timelineMutationContext(payload);
  const currentItems = await fullProjectItems(project);
  if (
    String(payload.expectedProjectItemsRevision || "") !== currentItems.revision
  ) {
    throw new Error("Project items changed; read them again");
  }
  const projectItemId = String(payload.projectItemId || "");
  let context = await findProjectItemContext(
    await project.getRootItem(),
    projectItemId,
  );
  if (!context) throw new Error("Project item not found");
  await assertRemovableProjectItem(context.item);
  await assertMutationBoundary(before, payload);
  const boundaryItems = await fullProjectItems(project);
  if (
    String(payload.expectedProjectItemsRevision || "") !==
    boundaryItems.revision
  ) {
    throw new Error("Project items changed while preparing item removal");
  }
  context = await findProjectItemContext(
    await project.getRootItem(),
    projectItemId,
  );
  if (!context) throw new Error("Project item changed while preparing removal");
  await assertRemovableProjectItem(context.item);
  const usedBy = await sequencesUsingProjectItem(project, projectItemId);
  if (usedBy.length > 0) {
    throw new Error(
      `Project item is still used in ${usedBy.length} sequence(s)`,
    );
  }
  const finalItems = await fullProjectItems(project);
  if (finalItems.revision !== boundaryItems.revision) {
    throw new Error("Project items changed while checking sequence usage");
  }
  // The all-sequence scan is asynchronous. Recheck the active identity and
  // complete timeline revision after it, immediately before the transaction.
  await assertMutationBoundary(before, payload);
  let success = false;
  project.lockedAccess(() => {
    success = project.executeTransaction((compoundAction: any) => {
      compoundAction.addAction(
        context!.parent.createRemoveItemAction(context!.item),
      );
    }, "Gateway for Premiere: remove project item");
  });
  if (!success)
    throw new Error("Premiere rejected the remove project item transaction");
  return { projectItems: await fullProjectItems(project) };
}

function componentValue(value: unknown): any {
  if (
    typeof value === "number" ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (
    Array.isArray(value) &&
    value.length === 2 &&
    value.every((item) => typeof item === "number")
  ) {
    return ppro.PointF(value[0], value[1]);
  }
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    if (typeof object.x === "number" && typeof object.y === "number") {
      return ppro.PointF(object.x, object.y);
    }
    if (
      typeof object.red === "number" &&
      typeof object.green === "number" &&
      typeof object.blue === "number" &&
      typeof object.alpha === "number"
    ) {
      return ppro.Color(object.red, object.green, object.blue, object.alpha);
    }
  }
  throw new Error("value must be a primitive, PointF, or Color");
}

async function componentSnapshots(item: any): Promise<ComponentSnapshot[]> {
  const chain = await item.getComponentChain();
  const itemStart = await item.getStartTime();
  const components: ComponentSnapshot[] = [];
  for (
    let componentIndex = 0;
    componentIndex < chain.getComponentCount();
    componentIndex += 1
  ) {
    const component = chain.getComponentAtIndex(componentIndex);
    const params = [];
    for (
      let paramIndex = 0;
      paramIndex < component.getParamCount();
      paramIndex += 1
    ) {
      params.push(
        await snapshotComponentParam(
          component.getParam(paramIndex),
          paramIndex,
          itemStart,
          seconds,
        ),
      );
    }
    components.push({
      index: componentIndex,
      displayName: String(await component.getDisplayName()),
      matchName: String(await component.getMatchName()),
      params,
    });
  }
  return components;
}

function expectIdentity(
  snapshot: TimelineSnapshot,
  payload: Record<string, unknown>,
): void {
  if (String(payload.expectedProjectGuid || "") !== snapshot.project.guid) {
    throw new Error("Active project changed; take a new snapshot");
  }
  if (String(payload.expectedSequenceGuid || "") !== snapshot.sequence.guid) {
    throw new Error("Active sequence changed; take a new snapshot");
  }
}

function expectRevision(
  snapshot: TimelineSnapshot,
  payload: Record<string, unknown>,
): void {
  expectIdentity(snapshot, payload);
  if (String(payload.expectedRevision || "") !== snapshot.revision) {
    throw new Error("Timeline changed; take a new snapshot");
  }
}

async function trackItemFor(
  sequence: any,
  snapshot: TimelineSnapshot,
  itemRef: unknown,
): Promise<{ snapshotItem: TimelineItem; item: any }> {
  const snapshotItem = snapshot.tracks
    .flatMap((track) => track.items)
    .find((item) => item.ref === String(itemRef || ""));
  if (!snapshotItem)
    throw new Error(`Track item not found: ${String(itemRef || "")}`);
  const track =
    snapshotItem.mediaType === "video"
      ? await sequence.getVideoTrack(snapshotItem.trackIndex)
      : await sequence.getAudioTrack(snapshotItem.trackIndex);
  const items = await track.getTrackItems(
    ppro.Constants.TrackItemType.CLIP,
    false,
  );
  const item = items[snapshotItem.itemIndex];
  if (!item) throw new Error("Track item changed; take a new snapshot");
  const projectItem = await item.getProjectItem();
  const currentProjectItemId = projectItem
    ? String(await projectItem.getId())
    : "";
  if (
    snapshotItem.projectItemId &&
    currentProjectItemId !== snapshotItem.projectItemId
  ) {
    throw new Error("Track item identity changed; take a new snapshot");
  }
  return { snapshotItem, item };
}

async function timelineMutationContext(
  payload: Record<string, unknown>,
  requireReliableRevision = true,
): Promise<{
  before: TimelineSnapshot;
  project: any;
  sequence: any;
}> {
  assertRequestActive(payload);
  const context = await activeContext();
  const before = await timelineSnapshot(context);
  expectRevision(before, payload);
  if (requireReliableRevision && before.revisionReliability !== "complete") {
    const opaqueOnly = before.revisionReliability === "opaque-transitions";
    const allowed =
      payload.allowIncompleteRevision === true ||
      (opaqueOnly && payload.allowOpaqueTransitions === true);
    if (!allowed) {
      throw new Error(
        `Timeline revision is ${before.revisionReliability}; pass allowIncompleteRevision: true only after visual review`,
      );
    }
  }
  const current = await activeContext();
  if (
    guid(current.project.guid) !== before.project.guid ||
    guid(current.sequence.guid) !== before.sequence.guid
  ) {
    throw new Error("Active project or sequence changed; take a new snapshot");
  }
  return { before, ...context };
}

async function trimTrackItem(
  payload: Record<string, unknown>,
): Promise<TimelineSnapshot> {
  if (payload.confirm !== true)
    throw new Error("trim_track_item requires confirm: true");
  const { before, project, sequence } = await timelineMutationContext(payload);
  const { snapshotItem: target, item } = await trackItemFor(
    sequence,
    before,
    payload.itemRef,
  );

  const startSeconds =
    payload.startSeconds === undefined
      ? undefined
      : Number(payload.startSeconds);
  const endSeconds =
    payload.endSeconds === undefined ? undefined : Number(payload.endSeconds);
  if (
    startSeconds !== undefined &&
    (!Number.isFinite(startSeconds) || startSeconds < 0)
  ) {
    throw new Error("startSeconds must be a non-negative number");
  }
  if (
    endSeconds !== undefined &&
    (!Number.isFinite(endSeconds) || endSeconds < 0)
  ) {
    throw new Error("endSeconds must be a non-negative number");
  }
  const nextStart = startSeconds ?? target.startSeconds;
  const nextEnd = endSeconds ?? target.endSeconds;
  if (nextStart >= nextEnd)
    throw new Error("Trim start must be before trim end");

  await execute(
    before,
    payload,
    project,
    "trim track item",
    (compoundAction) => {
      if (startSeconds !== undefined) {
        compoundAction.addAction(
          item.createSetStartAction(
            ppro.TickTime.createWithSeconds(startSeconds),
          ),
        );
      }
      if (endSeconds !== undefined) {
        compoundAction.addAction(
          item.createSetEndAction(ppro.TickTime.createWithSeconds(endSeconds)),
        );
      }
    },
  );
  return timelineSnapshot({ project, sequence });
}

async function insertProjectItem(
  payload: Record<string, unknown>,
): Promise<TimelineSnapshot> {
  if (payload.confirm !== true)
    throw new Error("insert_project_item requires confirm: true");
  const { before, project, sequence } = await timelineMutationContext(payload);
  const projectItemId = String(payload.projectItemId || "");
  if (!projectItemId) throw new Error("projectItemId is required");
  const projectItem = await findProjectItem(
    await project.getRootItem(),
    projectItemId,
  );
  if (!projectItem) throw new Error(`Project item not found: ${projectItemId}`);
  if (
    projectItem.type === ppro.ProjectItem.TYPE_BIN ||
    projectItem.type === ppro.ProjectItem.TYPE_ROOT
  ) {
    throw new Error("A bin cannot be inserted into the timeline");
  }
  const timeSeconds = finiteNumber(payload.timeSeconds, "timeSeconds");
  if (timeSeconds < 0) throw new Error("timeSeconds must be >= 0");
  const videoTrackIndex = integer(payload.videoTrackIndex, "videoTrackIndex");
  const audioTrackIndex = integer(payload.audioTrackIndex, "audioTrackIndex");
  const mode = String(payload.mode || "insert");
  if (!new Set(["insert", "overwrite"]).has(mode))
    throw new Error("mode must be insert or overwrite");
  const editor = ppro.SequenceEditor.getEditor(sequence);
  const time = ppro.TickTime.createWithSeconds(timeSeconds);
  await execute(
    before,
    payload,
    project,
    `${mode} project item`,
    (compoundAction) => {
      const action =
        mode === "insert"
          ? editor.createInsertProjectItemAction(
              projectItem,
              time,
              videoTrackIndex,
              audioTrackIndex,
              booleanValue(payload.limitShift ?? true, "limitShift"),
            )
          : editor.createOverwriteItemAction(
              projectItem,
              time,
              videoTrackIndex,
              audioTrackIndex,
            );
      compoundAction.addAction(action);
    },
  );
  const after = await timelineSnapshot({ project, sequence });
  if (after.revision === before.revision)
    throw new Error(
      "Premiere reported success but the timeline did not change",
    );
  return after;
}

async function insertMogrt(payload: Record<string, unknown>): Promise<{
  timeline: TimelineSnapshot;
  insertedItemCount: number;
}> {
  if (payload.confirm !== true)
    throw new Error("insert_mogrt requires confirm: true");
  const { before, project, sequence } = await timelineMutationContext(payload);
  const inputFile = String(payload.inputFile || "");
  if (!inputFile.startsWith("/") || !inputFile.toLowerCase().endsWith(".mogrt"))
    throw new Error("MOGRT path must be an absolute .mogrt file");
  const timeSeconds = finiteNumber(payload.timeSeconds, "timeSeconds");
  if (timeSeconds < 0) throw new Error("timeSeconds must be >= 0");
  const videoTrackIndex = integer(payload.videoTrackIndex, "videoTrackIndex");
  const audioTrackIndex = integer(payload.audioTrackIndex, "audioTrackIndex");
  const editor = ppro.SequenceEditor.getEditor(sequence);

  return runMogrtMutation({
    beforeRevision: before.revision,
    prepare: () => assertMutationBoundary(before, payload),
    start: (markStarted) => {
      let insertedItemCount = 0;
      project.lockedAccess(() => {
        markStarted();
        insertedItemCount = editor.insertMogrtFromPath(
          inputFile,
          ppro.TickTime.createWithSeconds(timeSeconds),
          videoTrackIndex,
          audioTrackIndex,
        ).length;
      });
      return insertedItemCount;
    },
    readSnapshot: () => timelineSnapshot({ project, sequence }),
  });
}

async function moveTrackItem(
  payload: Record<string, unknown>,
): Promise<TimelineSnapshot> {
  if (payload.confirm !== true)
    throw new Error("move_track_item requires confirm: true");
  const { before, project, sequence } = await timelineMutationContext(payload);
  const { snapshotItem, item } = await trackItemFor(
    sequence,
    before,
    payload.itemRef,
  );
  const offsetSeconds = finiteNumber(payload.offsetSeconds, "offsetSeconds");
  if (offsetSeconds === 0) throw new Error("offsetSeconds must not be zero");
  if (snapshotItem.startSeconds + offsetSeconds < 0)
    throw new Error("Move would place the item before sequence start");
  await execute(
    before,
    payload,
    project,
    "move track item",
    (compoundAction) => {
      compoundAction.addAction(
        item.createMoveAction(ppro.TickTime.createWithSeconds(offsetSeconds)),
      );
    },
  );
  return timelineSnapshot({ project, sequence });
}

async function cloneTrackItem(
  payload: Record<string, unknown>,
): Promise<TimelineSnapshot> {
  if (payload.confirm !== true)
    throw new Error("clone_track_item requires confirm: true");
  const { before, project, sequence } = await timelineMutationContext(payload);
  const { snapshotItem, item } = await trackItemFor(
    sequence,
    before,
    payload.itemRef,
  );
  const offsetSeconds = finiteNumber(payload.offsetSeconds, "offsetSeconds");
  if (snapshotItem.startSeconds + offsetSeconds < 0)
    throw new Error("Clone would be placed before sequence start");
  const editor = ppro.SequenceEditor.getEditor(sequence);
  await execute(
    before,
    payload,
    project,
    "clone track item",
    (compoundAction) => {
      compoundAction.addAction(
        editor.createCloneTrackItemAction(
          item,
          ppro.TickTime.createWithSeconds(offsetSeconds),
          integer(payload.videoTrackOffset ?? 0, "videoTrackOffset", -100),
          integer(payload.audioTrackOffset ?? 0, "audioTrackOffset", -100),
          booleanValue(payload.alignToVideo ?? true, "alignToVideo"),
          booleanValue(payload.insert ?? false, "insert"),
        ),
      );
    },
  );
  return timelineSnapshot({ project, sequence });
}

async function removeTrackItem(
  payload: Record<string, unknown>,
): Promise<TimelineSnapshot> {
  if (payload.confirm !== true)
    throw new Error("remove_track_item requires confirm: true");
  const { before, project, sequence } = await timelineMutationContext(payload);
  const { snapshotItem, item } = await trackItemFor(
    sequence,
    before,
    payload.itemRef,
  );
  if (!(await sequence.clearSelection()))
    throw new Error("Could not clear track item selection");
  const selection = await sequence.getSelection();
  if (!selection.addItem(item, false) || !sequence.setSelection(selection))
    throw new Error("Could not add track item to selection");
  const editor = ppro.SequenceEditor.getEditor(sequence);
  const mediaType =
    snapshotItem.mediaType === "video"
      ? ppro.Constants.MediaType.VIDEO
      : ppro.Constants.MediaType.AUDIO;
  await execute(
    before,
    payload,
    project,
    "remove track item",
    (compoundAction) => {
      compoundAction.addAction(
        editor.createRemoveItemsAction(
          selection,
          booleanValue(payload.ripple ?? false, "ripple"),
          mediaType,
          booleanValue(payload.shiftOverlapping ?? false, "shiftOverlapping"),
        ),
      );
    },
  );
  return timelineSnapshot({ project, sequence });
}

async function updateTrackItem(
  payload: Record<string, unknown>,
): Promise<TimelineSnapshot> {
  if (payload.confirm !== true)
    throw new Error("update_track_item requires confirm: true");
  const { before, project, sequence } = await timelineMutationContext(payload);
  const { item } = await trackItemFor(sequence, before, payload.itemRef);
  const hasName = typeof payload.name === "string" && payload.name.length > 0;
  const hasDisabled = typeof payload.disabled === "boolean";
  if (!hasName && !hasDisabled)
    throw new Error("update_track_item requires name or disabled");
  await execute(
    before,
    payload,
    project,
    "update track item",
    (compoundAction) => {
      if (hasName)
        compoundAction.addAction(item.createSetNameAction(payload.name));
      if (hasDisabled)
        compoundAction.addAction(
          item.createSetDisabledAction(payload.disabled),
        );
    },
  );
  return timelineSnapshot({ project, sequence });
}

async function updateTrack(
  payload: Record<string, unknown>,
): Promise<TimelineSnapshot> {
  if (payload.confirm !== true)
    throw new Error("update_track requires confirm: true");
  const { before, project, sequence } = await timelineMutationContext(payload);
  const mediaType = String(payload.mediaType || "");
  if (mediaType !== "video" && mediaType !== "audio")
    throw new Error("mediaType must be video or audio");
  const trackIndex = integer(payload.trackIndex, "trackIndex", 0);
  const name = String(payload.name || "");
  if (!name) throw new Error("update_track requires a non-empty name");
  const snapshotTrack = before.tracks.find(
    (track) => track.mediaType === mediaType && track.index === trackIndex,
  );
  if (!snapshotTrack) throw new Error("Track not found; take a new snapshot");
  const track =
    mediaType === "video"
      ? await sequence.getVideoTrack(trackIndex)
      : await sequence.getAudioTrack(trackIndex);
  if (
    Number(track.id) !== snapshotTrack.id ||
    Number(await track.getIndex()) !== snapshotTrack.index
  ) {
    throw new Error("Track identity changed; take a new snapshot");
  }
  await execute(before, payload, project, "rename track", (compoundAction) => {
    compoundAction.addAction(track.createSetNameAction(name));
  });
  return timelineSnapshot({ project, sequence });
}

async function addVideoTransition(
  payload: Record<string, unknown>,
): Promise<TimelineSnapshot> {
  if (payload.confirm !== true)
    throw new Error("add_video_transition requires confirm: true");
  const { before, project, sequence } = await timelineMutationContext(payload);
  const { snapshotItem, item } = await trackItemFor(
    sequence,
    before,
    payload.itemRef,
  );
  if (snapshotItem.mediaType !== "video")
    throw new Error("Video transitions require a video track item");
  const matchName = String(payload.matchName || "");
  const installed = await ppro.TransitionFactory.getVideoTransitionMatchNames();
  if (!installed.includes(matchName))
    throw new Error(`Video transition is not installed: ${matchName}`);
  const position = String(payload.position || "start");
  if (!new Set(["start", "end"]).has(position))
    throw new Error("position must be start or end");
  const options = ppro.AddTransitionOptions();
  options.setApplyToStart(position === "start");
  options.setForceSingleSided(
    booleanValue(payload.forceSingleSided ?? false, "forceSingleSided"),
  );
  if (payload.durationSeconds !== undefined) {
    const duration = finiteNumber(payload.durationSeconds, "durationSeconds");
    if (duration <= 0) throw new Error("durationSeconds must be > 0");
    options.setDuration(ppro.TickTime.createWithSeconds(duration));
  }
  const transition = ppro.TransitionFactory.createVideoTransition(matchName);
  await execute(
    before,
    payload,
    project,
    "add video transition",
    (compoundAction) => {
      compoundAction.addAction(
        item.createAddVideoTransitionAction(transition, options),
      );
    },
  );
  return timelineSnapshot({ project, sequence });
}

async function removeVideoTransition(
  payload: Record<string, unknown>,
): Promise<TimelineSnapshot> {
  if (payload.confirm !== true)
    throw new Error("remove_video_transition requires confirm: true");
  const { before, project, sequence } = await timelineMutationContext(payload);
  const { snapshotItem, item } = await trackItemFor(
    sequence,
    before,
    payload.itemRef,
  );
  if (snapshotItem.mediaType !== "video")
    throw new Error("Video transitions require a video track item");
  const position = String(payload.position || "start");
  const transitionPosition =
    position === "start"
      ? ppro.Constants.TransitionPosition.START
      : position === "end"
        ? ppro.Constants.TransitionPosition.END
        : undefined;
  if (transitionPosition === undefined)
    throw new Error("position must be start or end");
  await execute(
    before,
    payload,
    project,
    "remove video transition",
    (compoundAction) => {
      compoundAction.addAction(
        item.createRemoveVideoTransitionAction(transitionPosition),
      );
    },
  );
  return timelineSnapshot({ project, sequence });
}

async function addVideoEffect(
  payload: Record<string, unknown>,
): Promise<{ timeline: TimelineSnapshot; components: ComponentSnapshot[] }> {
  if (payload.confirm !== true)
    throw new Error("add_video_effect requires confirm: true");
  const { before, project, sequence } = await timelineMutationContext(payload);
  const { snapshotItem, item } = await trackItemFor(
    sequence,
    before,
    payload.itemRef,
  );
  if (snapshotItem.mediaType !== "video")
    throw new Error("Video effects require a video track item");
  const matchName = String(payload.matchName || "");
  const installed = await ppro.VideoFilterFactory.getMatchNames();
  if (!installed.includes(matchName))
    throw new Error(`Video effect is not installed: ${matchName}`);
  const chain = await item.getComponentChain();
  const insertionIndex = integer(
    payload.insertionIndex ?? chain.getComponentCount(),
    "insertionIndex",
  );
  assertEffectInsertionIndex(insertionIndex, chain.getComponentCount());
  const component = await ppro.VideoFilterFactory.createComponent(matchName);
  await execute(
    before,
    payload,
    project,
    "add video effect",
    (compoundAction) => {
      compoundAction.addAction(
        chain.createInsertComponentAction(component, insertionIndex),
      );
    },
  );
  return {
    timeline: await timelineSnapshot({ project, sequence }),
    components: await componentSnapshots(item),
  };
}

async function addAudioEffect(
  payload: Record<string, unknown>,
): Promise<{ timeline: TimelineSnapshot; components: ComponentSnapshot[] }> {
  if (payload.confirm !== true)
    throw new Error("add_audio_effect requires confirm: true");
  const { before, project, sequence } = await timelineMutationContext(payload);
  const { snapshotItem, item } = await trackItemFor(
    sequence,
    before,
    payload.itemRef,
  );
  if (snapshotItem.mediaType !== "audio")
    throw new Error("Audio effects require an audio track item");
  const displayName = String(payload.displayName || "");
  const installed = await ppro.AudioFilterFactory.getDisplayNames();
  if (!installed.includes(displayName))
    throw new Error(`Audio effect is not installed: ${displayName}`);
  const chain = await item.getComponentChain();
  const insertionIndex = integer(
    payload.insertionIndex ?? chain.getComponentCount(),
    "insertionIndex",
  );
  assertEffectInsertionIndex(insertionIndex, chain.getComponentCount());
  const component = await ppro.AudioFilterFactory.createComponentByDisplayName(
    displayName,
    item,
  );
  await execute(
    before,
    payload,
    project,
    "add audio effect",
    (compoundAction) => {
      compoundAction.addAction(
        chain.createInsertComponentAction(component, insertionIndex),
      );
    },
  );
  return {
    timeline: await timelineSnapshot({ project, sequence }),
    components: await componentSnapshots(item),
  };
}

async function removeAudioEffect(
  payload: Record<string, unknown>,
): Promise<{ timeline: TimelineSnapshot; components: ComponentSnapshot[] }> {
  if (payload.confirm !== true)
    throw new Error("remove_audio_effect requires confirm: true");
  const { before, project, sequence } = await timelineMutationContext(payload);
  const { snapshotItem, item } = await trackItemFor(
    sequence,
    before,
    payload.itemRef,
  );
  if (snapshotItem.mediaType !== "audio")
    throw new Error("Audio effects require an audio track item");
  const chain = await item.getComponentChain();
  const componentIndex = integer(payload.componentIndex, "componentIndex");
  assertRemovableEffectIndex(componentIndex, chain.getComponentCount());
  const component = chain.getComponentAtIndex(componentIndex);
  await execute(
    before,
    payload,
    project,
    "remove audio effect",
    (compoundAction) => {
      compoundAction.addAction(chain.createRemoveComponentAction(component));
    },
  );
  return {
    timeline: await timelineSnapshot({ project, sequence }),
    components: await componentSnapshots(item),
  };
}

async function removeVideoEffect(
  payload: Record<string, unknown>,
): Promise<{ timeline: TimelineSnapshot; components: ComponentSnapshot[] }> {
  if (payload.confirm !== true)
    throw new Error("remove_video_effect requires confirm: true");
  const { before, project, sequence } = await timelineMutationContext(payload);
  const { snapshotItem, item } = await trackItemFor(
    sequence,
    before,
    payload.itemRef,
  );
  if (snapshotItem.mediaType !== "video")
    throw new Error("Video effects require a video track item");
  const chain = await item.getComponentChain();
  const componentIndex = integer(payload.componentIndex, "componentIndex");
  assertRemovableEffectIndex(componentIndex, chain.getComponentCount());
  const component = chain.getComponentAtIndex(componentIndex);
  await execute(
    before,
    payload,
    project,
    "remove video effect",
    (compoundAction) => {
      compoundAction.addAction(chain.createRemoveComponentAction(component));
    },
  );
  return {
    timeline: await timelineSnapshot({ project, sequence }),
    components: await componentSnapshots(item),
  };
}

async function trackItemComponents(payload: Record<string, unknown>): Promise<{
  itemRef: string;
  revision: string;
  components: ComponentSnapshot[];
}> {
  const { before, sequence } = await timelineMutationContext(payload, false);
  const { item } = await trackItemFor(sequence, before, payload.itemRef);
  return {
    itemRef: String(payload.itemRef),
    revision: before.revision,
    components: await componentSnapshots(item),
  };
}

async function setComponentParam(
  payload: Record<string, unknown>,
): Promise<{ timeline: TimelineSnapshot; components: ComponentSnapshot[] }> {
  if (payload.confirm !== true)
    throw new Error("set_component_param requires confirm: true");
  const { before, project, sequence } = await timelineMutationContext(payload);
  const { item } = await trackItemFor(sequence, before, payload.itemRef);
  const chain = await item.getComponentChain();
  const componentIndex = integer(payload.componentIndex, "componentIndex");
  if (componentIndex >= chain.getComponentCount())
    throw new Error("componentIndex exceeds component count");
  const component = chain.getComponentAtIndex(componentIndex);
  const paramIndex = integer(payload.paramIndex, "paramIndex");
  if (paramIndex >= component.getParamCount())
    throw new Error("paramIndex exceeds parameter count");
  const param = component.getParam(paramIndex);
  if (param.empty) throw new Error("Component parameter is empty");
  readableComponentParam(
    await componentSnapshots(item),
    componentIndex,
    paramIndex,
  );
  if (param.isTimeVarying())
    throw new Error("Time-varying parameters require keyframe-aware editing");
  const keyframe = param.createKeyframe(componentValue(payload.value));
  await execute(
    before,
    payload,
    project,
    "set component parameter",
    (compoundAction) => {
      compoundAction.addAction(param.createSetTimeVaryingAction(false));
      compoundAction.addAction(param.createSetValueAction(keyframe, true));
    },
  );
  return {
    timeline: await timelineSnapshot({ project, sequence }),
    components: await componentSnapshots(item),
  };
}

function interpolationMode(value: unknown): number {
  const modes: Record<string, number> = {
    linear: ppro.Keyframe.INTERPOLATION_MODE_LINEAR,
    hold: ppro.Keyframe.INTERPOLATION_MODE_HOLD,
    bezier: ppro.Keyframe.INTERPOLATION_MODE_BEZIER,
    time: ppro.Keyframe.INTERPOLATION_MODE_TIME,
  };
  const name = String(value ?? "linear");
  const mode = modes[name];
  if (mode === undefined) {
    throw new Error("interpolation must be linear, hold, bezier, or time");
  }
  return mode;
}

async function componentParamContext(
  payload: Record<string, unknown>,
): Promise<{
  before: TimelineSnapshot;
  project: any;
  sequence: any;
  snapshotItem: TimelineItem;
  item: any;
  param: any;
}> {
  const { before, project, sequence } = await timelineMutationContext(payload);
  const { snapshotItem, item } = await trackItemFor(
    sequence,
    before,
    payload.itemRef,
  );
  const chain = await item.getComponentChain();
  const componentIndex = integer(payload.componentIndex, "componentIndex");
  if (componentIndex >= chain.getComponentCount())
    throw new Error("componentIndex exceeds component count");
  const component = chain.getComponentAtIndex(componentIndex);
  const paramIndex = integer(payload.paramIndex, "paramIndex");
  if (paramIndex >= component.getParamCount())
    throw new Error("paramIndex exceeds parameter count");
  const param = component.getParam(paramIndex);
  if (param.empty) throw new Error("Component parameter is empty");
  readableComponentParam(
    await componentSnapshots(item),
    componentIndex,
    paramIndex,
  );
  return { before, project, sequence, snapshotItem, item, param };
}

function keyframeAt(param: any, timeSeconds: number): any | undefined {
  return param
    .getKeyframeListAsTickTimes()
    .find((time: any) => Math.abs(seconds(time) - timeSeconds) < 0.000001);
}

async function setComponentKeyframe(
  payload: Record<string, unknown>,
): Promise<{ timeline: TimelineSnapshot; components: ComponentSnapshot[] }> {
  if (payload.confirm !== true)
    throw new Error("set_component_keyframe requires confirm: true");
  const { before, project, sequence, snapshotItem, item, param } =
    await componentParamContext(payload);
  if (!(await param.areKeyframesSupported()))
    throw new Error("Component parameter does not support keyframes");
  const timeSeconds = finiteNumber(payload.timeSeconds, "timeSeconds");
  if (
    timeSeconds < snapshotItem.startSeconds ||
    timeSeconds > snapshotItem.endSeconds
  ) {
    throw new Error("Keyframe time must be within the track item");
  }
  const time = ppro.TickTime.createWithSeconds(timeSeconds);
  const existingTime = keyframeAt(param, timeSeconds);
  const keyframe = param.createKeyframe(componentValue(payload.value));
  keyframe.position = time;
  if (
    !(await keyframe.setTemporalInterpolationMode(
      interpolationMode(payload.interpolation),
    ))
  ) {
    throw new Error("Premiere rejected the keyframe interpolation mode");
  }
  await execute(
    before,
    payload,
    project,
    "set component keyframe",
    (compoundAction) => {
      compoundAction.addAction(param.createSetTimeVaryingAction(true));
      if (existingTime) {
        compoundAction.addAction(
          param.createRemoveKeyframeAction(existingTime, true),
        );
      }
      compoundAction.addAction(param.createAddKeyframeAction(keyframe));
    },
  );
  return {
    timeline: await timelineSnapshot({ project, sequence }),
    components: await componentSnapshots(item),
  };
}

async function removeComponentKeyframe(
  payload: Record<string, unknown>,
): Promise<{ timeline: TimelineSnapshot; components: ComponentSnapshot[] }> {
  if (payload.confirm !== true)
    throw new Error("remove_component_keyframe requires confirm: true");
  const { before, project, sequence, item, param } =
    await componentParamContext(payload);
  if (!param.isTimeVarying())
    throw new Error("Component parameter is not time-varying");
  const timeSeconds = finiteNumber(payload.timeSeconds, "timeSeconds");
  const keyframeTimes = param.getKeyframeListAsTickTimes();
  const existingTime = keyframeAt(param, timeSeconds);
  if (!existingTime)
    throw new Error("Keyframe not found at the requested time");
  await execute(
    before,
    payload,
    project,
    "remove component keyframe",
    (compoundAction) => {
      compoundAction.addAction(
        param.createRemoveKeyframeAction(existingTime, true),
      );
      if (keyframeTimes.length === 1) {
        compoundAction.addAction(param.createSetTimeVaryingAction(false));
      }
    },
  );
  return {
    timeline: await timelineSnapshot({ project, sequence }),
    components: await componentSnapshots(item),
  };
}

async function sequenceSummaries(project: any): Promise<
  Array<{
    guid: string;
    name: string;
    active: boolean;
    revision: string;
    revisionReliability: TimelineSnapshot["revisionReliability"];
    projectItemId?: string;
  }>
> {
  const active = await project.getActiveSequence();
  const activeGuid = active ? guid(active.guid) : "";
  const summaries = [];
  for (const sequence of await project.getSequences()) {
    let projectItemId: string | undefined;
    try {
      const item = await sequence.getProjectItem();
      if (item) projectItemId = String(await item.getId());
    } catch {
      // A sequence can be transitioning between project-panel states.
    }
    const snapshot = await timelineSnapshot({ project, sequence });
    summaries.push({
      guid: guid(sequence.guid),
      name: String(sequence.name || ""),
      active: guid(sequence.guid) === activeGuid,
      revision: snapshot.revision,
      revisionReliability: snapshot.revisionReliability,
      ...(projectItemId ? { projectItemId } : {}),
    });
  }
  return summaries;
}

async function sequenceByGuid(
  project: any,
  requestedGuid: unknown,
): Promise<any> {
  const value = String(requestedGuid || "");
  if (!value) throw new Error("sequenceGuid is required");
  const sequence = (await project.getSequences()).find(
    (candidate: any) => guid(candidate.guid) === value,
  );
  if (!sequence) throw new Error(`Sequence not found: ${value}`);
  return sequence;
}

function rectSnapshot(value: any): { width: number; height: number } {
  return { width: Number(value.width), height: Number(value.height) };
}

async function sequenceSettingsSnapshot(
  sequence: any,
): Promise<Record<string, unknown>> {
  const settings = await sequence.getSettings();
  const audioDisplay = await settings.getAudioDisplayFormat();
  const videoDisplay = await settings.getVideoDisplayFormat();
  const audioRate = await settings.getAudioSampleRate();
  const videoRate = await settings.getVideoFrameRate();
  return {
    maximumBitDepth: Boolean(await settings.getMaximumBitDepth()),
    maximumRenderQuality: Boolean(await settings.getMaxRenderQuality()),
    audioChannelCount: Number(await settings.getAudioChannelCount()),
    audioChannelType: Number(await settings.getAudioChannelType()),
    audioDisplayFormat: Number(audioDisplay.type),
    audioSampleRate: Number(audioRate.value),
    videoDisplayFormat: Number(videoDisplay.type),
    videoFieldType: Number(await settings.getVideoFieldType()),
    videoFrameRate: Number(videoRate.value),
    videoFrameRect: rectSnapshot(await settings.getVideoFrameRect()),
    videoPixelAspectRatio: String(await settings.getVideoPixelAspectRatio()),
    compositeInLinearColor: Boolean(await settings.getCompositeInLinearColor()),
    editingMode: String(await settings.getEditingMode()),
    previewFileFormat: String(await settings.getPreviewFileFormat()),
    previewCodec: String(await settings.getPreviewCodec()),
    previewFrameRect: rectSnapshot(await settings.getPreviewFrameRect()),
  };
}

async function createSequence(
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (payload.confirm !== true)
    throw new Error("create_sequence requires confirm: true");
  const { before, project } = await timelineMutationContext(payload);
  const name = String(payload.name || "").trim();
  if (!name) throw new Error("Sequence name is required");
  const items = await fullProjectItems(project);
  if (String(payload.expectedProjectItemsRevision || "") !== items.revision) {
    throw new Error("Project items changed; read them again");
  }
  const presetFile = payload.presetFile
    ? String(payload.presetFile)
    : undefined;
  const boundaryItems = await fullProjectItems(project);
  if (boundaryItems.revision !== items.revision) {
    throw new Error("Project items changed while preparing the sequence");
  }
  await assertMutationBoundary(before, payload);
  const sequence = presetFile
    ? await project.createSequenceWithPresetPath(name, presetFile)
    : await project.createSequence(name);
  if (!sequence) throw new Error("Premiere did not create the sequence");
  const createdGuid = guid(sequence.guid);
  const sequences = await sequenceSummaries(project);
  if (!sequences.some((candidate) => candidate.guid === createdGuid)) {
    throw new RequestUnknownOutcomeError(
      "Sequence creation started, but its outcome could not be confirmed",
    );
  }
  return { createdGuid, sequences };
}

async function createSequenceFromMedia(
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (payload.confirm !== true)
    throw new Error("create_sequence_from_media requires confirm: true");
  const { before, project } = await timelineMutationContext(payload);
  const name = String(payload.name || "").trim();
  if (!name) throw new Error("Sequence name is required");
  const requestedIds = payload.projectItemIds;
  if (
    !Array.isArray(requestedIds) ||
    requestedIds.length === 0 ||
    requestedIds.some((value) => typeof value !== "string" || !value)
  ) {
    throw new Error("projectItemIds must be a non-empty string array");
  }
  const items = await fullProjectItems(project);
  if (String(payload.expectedProjectItemsRevision || "") !== items.revision) {
    throw new Error("Project items changed; read them again");
  }
  const root = await project.getRootItem();
  const clips = [];
  for (const id of requestedIds) {
    const item = await findProjectItem(root, id);
    if (!item || item.type !== ppro.ProjectItem.TYPE_CLIP) {
      throw new Error(`Clip project item not found: ${id}`);
    }
    clips.push(ppro.ClipProjectItem.cast(item));
  }
  let targetBin: any;
  if (payload.targetBinId) {
    const item = await findProjectItem(root, String(payload.targetBinId));
    if (!item || item.type !== ppro.ProjectItem.TYPE_BIN) {
      throw new Error("Target bin was not found");
    }
    targetBin = item;
  }
  const boundaryItems = await fullProjectItems(project);
  if (boundaryItems.revision !== items.revision) {
    throw new Error("Project items changed while preparing the sequence");
  }
  await assertMutationBoundary(before, payload);
  const sequence = await project.createSequenceFromMedia(
    name,
    clips,
    targetBin,
  );
  if (!sequence) throw new Error("Premiere did not create the sequence");
  const createdGuid = guid(sequence.guid);
  return { createdGuid, sequences: await sequenceSummaries(project) };
}

async function changeSequenceState(
  operation: "delete" | "activate" | "open" | "close",
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (payload.confirm !== true)
    throw new Error(`${operation}_sequence requires confirm: true`);
  const { before, project } = await timelineMutationContext(payload);
  const target = await sequenceByGuid(project, payload.sequenceGuid);
  const expectedTargetRevision = String(
    payload.expectedTargetSequenceRevision || "",
  );
  if (!expectedTargetRevision) {
    throw new Error("expectedTargetSequenceRevision is required");
  }
  const targetBefore = await timelineSnapshot({ project, sequence: target });
  if (targetBefore.revision !== expectedTargetRevision) {
    throw new Error("Target sequence changed; list sequences again");
  }
  if (operation === "delete" && guid(target.guid) === before.sequence.guid) {
    throw new Error("Activate another sequence before deleting this sequence");
  }
  await assertMutationBoundary(before, payload);
  const targetBoundary = await timelineSnapshot({ project, sequence: target });
  if (targetBoundary.revision !== expectedTargetRevision) {
    throw new Error("Target sequence changed while preparing the operation");
  }
  await assertMutationBoundary(before, payload);
  const success =
    operation === "delete"
      ? await project.deleteSequence(target)
      : operation === "activate"
        ? await project.setActiveSequence(target)
        : operation === "open"
          ? await project.openSequence(target)
          : await project.closeSequence(target);
  if (!success) throw new Error(`Premiere rejected ${operation} sequence`);
  const sequences = await sequenceSummaries(project);
  if (
    operation === "delete" &&
    sequences.some((candidate) => candidate.guid === guid(target.guid))
  ) {
    throw new RequestUnknownOutcomeError(
      "Sequence deletion started, but the sequence is still present",
    );
  }
  return { success: true, sequences };
}

async function cloneSequence(
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (payload.confirm !== true)
    throw new Error("clone_sequence requires confirm: true");
  const { before, project } = await timelineMutationContext(payload);
  const target = await sequenceByGuid(
    project,
    payload.sequenceGuid || before.sequence.guid,
  );
  if (guid(target.guid) !== before.sequence.guid) {
    throw new Error("Only the active sequence can be cloned");
  }
  const previous = new Set(
    (await project.getSequences()).map((sequence: any) => guid(sequence.guid)),
  );
  await execute(before, payload, project, "clone sequence", (action) => {
    action.addAction(target.createCloneAction());
  });
  const sequences = await sequenceSummaries(project);
  const created = sequences.find((sequence) => !previous.has(sequence.guid));
  if (!created) {
    throw new RequestUnknownOutcomeError(
      "Sequence clone completed, but the new sequence could not be identified",
    );
  }
  return { createdGuid: created.guid, sequences };
}

async function createSubsequence(
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (payload.confirm !== true)
    throw new Error("create_subsequence requires confirm: true");
  const { before, project, sequence } = await timelineMutationContext(payload);
  await assertMutationBoundary(before, payload);
  const created = await sequence.createSubsequence(
    payload.ignoreTrackTargeting === true,
  );
  if (!created) throw new Error("Premiere did not create a subsequence");
  return {
    createdGuid: guid(created.guid),
    sequences: await sequenceSummaries(project),
  };
}

async function setSequenceBounds(
  payload: Record<string, unknown>,
): Promise<TimelineSnapshot> {
  if (payload.confirm !== true)
    throw new Error("set_sequence_bounds requires confirm: true");
  const { before, project, sequence } = await timelineMutationContext(payload);
  const entries = [
    ["inSeconds", "in"],
    ["outSeconds", "out"],
    ["zeroSeconds", "zero"],
  ] as const;
  const requested = entries.filter(([key]) => payload[key] !== undefined);
  if (requested.length === 0)
    throw new Error("At least one sequence bound is required");
  await execute(before, payload, project, "set sequence bounds", (action) => {
    for (const [key, kind] of requested) {
      const value = finiteNumber(payload[key], key);
      if (value < 0) throw new Error(`${key} must be >= 0`);
      const time = ppro.TickTime.createWithSeconds(value);
      action.addAction(
        kind === "in"
          ? sequence.createSetInPointAction(time)
          : kind === "out"
            ? sequence.createSetOutPointAction(time)
            : sequence.createSetZeroPointAction(time),
      );
    }
  });
  return timelineSnapshot({ project, sequence });
}

async function setSequencePlayhead(
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (payload.confirm !== true)
    throw new Error("set_sequence_playhead requires confirm: true");
  const { before, sequence } = await timelineMutationContext(payload);
  const timeSeconds = finiteNumber(payload.timeSeconds, "timeSeconds");
  if (timeSeconds < 0) throw new Error("timeSeconds must be >= 0");
  await assertMutationBoundary(before, payload);
  const success = await sequence.setPlayerPosition(
    ppro.TickTime.createWithSeconds(timeSeconds),
  );
  if (!success) throw new Error("Premiere rejected the playhead position");
  return { timeSeconds: seconds(await sequence.getPlayerPosition()) };
}

async function setSequenceSettings(
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (payload.confirm !== true)
    throw new Error("set_sequence_settings requires confirm: true");
  const { before, project, sequence } = await timelineMutationContext(payload);
  const changes = payload.settings;
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) {
    throw new Error("settings must be an object");
  }
  const values = changes as Record<string, unknown>;
  const settings = await sequence.getSettings();
  const supported = new Set([
    "maximumBitDepth",
    "maximumRenderQuality",
    "audioDisplayFormat",
    "audioSampleRate",
    "videoDisplayFormat",
    "videoFieldType",
    "videoFrameRate",
    "videoFrameRect",
    "videoPixelAspectRatio",
    "compositeInLinearColor",
    "editingMode",
    "previewFileFormat",
    "previewCodec",
    "previewFrameRect",
  ]);
  const unknown = Object.keys(values).find((key) => !supported.has(key));
  if (unknown) throw new Error(`Unsupported sequence setting: ${unknown}`);
  if (Object.keys(values).length === 0)
    throw new Error("At least one sequence setting is required");
  if (values.maximumBitDepth !== undefined)
    await settings.setMaximumBitDepth(
      booleanValue(values.maximumBitDepth, "maximumBitDepth"),
    );
  if (values.maximumRenderQuality !== undefined)
    await settings.setMaxRenderQuality(
      booleanValue(values.maximumRenderQuality, "maximumRenderQuality"),
    );
  if (values.audioDisplayFormat !== undefined) {
    const display = await settings.getAudioDisplayFormat();
    display.type = integer(values.audioDisplayFormat, "audioDisplayFormat");
    await settings.setAudioDisplayFormat(display);
  }
  if (values.audioSampleRate !== undefined)
    await settings.setAudioSampleRate(
      ppro.FrameRate.createWithValue(
        finiteNumber(values.audioSampleRate, "audioSampleRate"),
      ),
    );
  if (values.videoDisplayFormat !== undefined) {
    const display = await settings.getVideoDisplayFormat();
    display.type = integer(values.videoDisplayFormat, "videoDisplayFormat");
    await settings.setVideoDisplayFormat(display);
  }
  if (values.videoFieldType !== undefined)
    await settings.setVideoFieldType(
      integer(values.videoFieldType, "videoFieldType"),
    );
  if (values.videoFrameRate !== undefined)
    settings.setVideoFrameRate(
      ppro.FrameRate.createWithValue(
        finiteNumber(values.videoFrameRate, "videoFrameRate"),
      ),
    );
  const setRect = async (
    key: "videoFrameRect" | "previewFrameRect",
  ): Promise<void> => {
    const value = values[key];
    if (value === undefined) return;
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error(`${key} must be an object`);
    const object = value as Record<string, unknown>;
    const rect = ppro.RectF();
    rect.width = integer(object.width, `${key}.width`, 1);
    rect.height = integer(object.height, `${key}.height`, 1);
    if (key === "videoFrameRect") await settings.setVideoFrameRect(rect);
    else await settings.setPreviewFrameRect(rect);
  };
  await setRect("videoFrameRect");
  await setRect("previewFrameRect");
  if (values.videoPixelAspectRatio !== undefined)
    await settings.setVideoPixelAspectRatio(
      String(values.videoPixelAspectRatio),
    );
  if (values.compositeInLinearColor !== undefined)
    await settings.setCompositeInLinearColor(
      booleanValue(values.compositeInLinearColor, "compositeInLinearColor"),
    );
  if (values.editingMode !== undefined)
    await settings.setEditingMode(String(values.editingMode));
  if (values.previewFileFormat !== undefined)
    await settings.setPreviewFileFormat(String(values.previewFileFormat));
  if (values.previewCodec !== undefined)
    await settings.setPreviewCodec(String(values.previewCodec));
  await execute(before, payload, project, "set sequence settings", (action) => {
    action.addAction(sequence.createSetSettingsAction(settings));
  });
  return sequenceSettingsSnapshot(sequence);
}

async function setTrackMuted(
  payload: Record<string, unknown>,
): Promise<TimelineSnapshot> {
  if (payload.confirm !== true)
    throw new Error("set_track_muted requires confirm: true");
  const { before, project, sequence } = await timelineMutationContext(payload);
  const mediaType = String(payload.mediaType || "");
  if (mediaType !== "video" && mediaType !== "audio" && mediaType !== "caption")
    throw new Error("mediaType must be video, audio, or caption");
  const index = integer(payload.trackIndex, "trackIndex");
  const track =
    mediaType === "video"
      ? await sequence.getVideoTrack(index)
      : mediaType === "audio"
        ? await sequence.getAudioTrack(index)
        : await sequence.getCaptionTrack(index);
  if (!track) throw new Error("Track not found");
  await assertMutationBoundary(before, payload);
  await track.setMute(booleanValue(payload.muted, "muted"));
  if ((await track.isMuted()) !== payload.muted) {
    throw new RequestUnknownOutcomeError(
      "Track mute operation started, but its outcome could not be confirmed",
    );
  }
  return timelineSnapshot({ project, sequence });
}

async function detectSceneEdits(
  payload: Record<string, unknown>,
): Promise<TimelineSnapshot> {
  if (payload.confirm !== true)
    throw new Error("detect_scene_edits requires confirm: true");
  const { before, project, sequence } = await timelineMutationContext(payload);
  const modes: Record<string, string> = {
    cuts: ppro.SequenceUtils.SEQUENCE_OPERATION_APPLYCUT,
    markers: ppro.SequenceUtils.SEQUENCE_OPERATION_CREATEMARKER,
    subclips: ppro.SequenceUtils.SEQUENCE_OPERATION_CREATESUBCLIP,
  };
  const operation = modes[String(payload.mode || "")];
  if (!operation) throw new Error("mode must be cuts, markers, or subclips");
  const selection = await sequence.getSelection();
  if ((await selection.getTrackItems()).length === 0)
    throw new Error("Scene edit detection requires a timeline selection");
  await assertMutationBoundary(before, payload);
  const success = await ppro.SequenceUtils.performSceneEditDetectionOnSelection(
    operation,
    selection,
  );
  if (!success) throw new Error("Premiere rejected scene edit detection");
  return timelineSnapshot({ project, sequence });
}

async function exportSequence(
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (payload.confirm !== true)
    throw new Error("export_sequence requires confirm: true");
  const { before, sequence } = await timelineMutationContext(payload);
  const outputFile = String(payload.outputFile || "");
  const presetFile = String(payload.presetFile || "");
  if (!outputFile.startsWith("/") || !presetFile.startsWith("/"))
    throw new Error("Export output and preset paths must be absolute");
  const extension = String(
    await ppro.EncoderManager.getExportFileExtension(sequence, presetFile),
  ).replace(/^\./, "");
  if (!extension) throw new Error("Premiere could not read the export preset");
  if (
    extension &&
    !outputFile.toLowerCase().endsWith(`.${extension.toLowerCase()}`)
  ) {
    throw new Error(`Export output must use .${extension}`);
  }
  await assertMutationBoundary(before, payload);
  const exported = await ppro.EncoderManager.getManager().exportSequence(
    sequence,
    ppro.Constants.ExportType.IMMEDIATELY,
    outputFile,
    presetFile,
    booleanValue(payload.exportFull ?? true, "exportFull"),
  );
  if (!exported) throw new Error("Premiere did not export the sequence");
  return {
    exported: true,
    outputFile,
    presetFile,
    extension,
    projectGuid: before.project.guid,
    sequenceGuid: before.sequence.guid,
    revision: before.revision,
  };
}

async function handleRequest(
  message: PluginRequest,
  connectionOpen: () => boolean,
): Promise<unknown> {
  const payload: Record<string, unknown> = {
    ...message.payload,
    [REQUEST_DEADLINE_KEY]: message.deadlineEpochMs,
    [REQUEST_CONNECTION_KEY]: connectionOpen,
  };
  assertRequestActive(payload);
  if (message.operation === "get_active_project") {
    const project = await activeProject();
    const sequence = await project.getActiveSequence();
    return {
      guid: guid(project.guid),
      name: String(project.name || ""),
      path: String(project.path || ""),
      activeSequence: sequence
        ? { guid: guid(sequence.guid), name: String(sequence.name || "") }
        : null,
    };
  }
  if (message.operation === "get_project_recovery") {
    const project = await activeProject();
    const settings = await ppro.ProjectSettings.getScratchDiskSettings(project);
    return {
      projectGuid: guid(project.guid),
      projectName: String(project.name || ""),
      projectPath: String(project.path || ""),
      autoSaveFolder: String(
        settings.getScratchDiskPath(
          ppro.Constants.ScratchDiskFolderType.AUTO_SAVE,
        ),
      ),
      autoSaveConfigurationReliability: "location-only",
    };
  }
  if (message.operation === "get_editing_snapshot")
    return editingSnapshot(payload);
  if (message.operation === "get_active_sequence") return timelineSnapshot();
  if (message.operation === "list_sequences") {
    return sequenceSummaries(await activeProject());
  }
  if (message.operation === "get_sequence_settings") {
    const { sequence } = await activeContext();
    return sequenceSettingsSnapshot(sequence);
  }
  if (message.operation === "get_project_items") return projectItems(payload);
  if (message.operation === "get_project_item_details")
    return projectItemDetails(payload);
  if (message.operation === "find_project_items_by_media_path")
    return findProjectItemsByMediaPath(payload);
  if (message.operation === "get_source_monitor")
    return sourceMonitorSnapshot();
  if (message.operation === "query_transcript_languages")
    return ppro.Transcript.querySupportedLanguages();
  if (message.operation === "get_clip_transcript")
    return clipTranscript(payload);
  if (message.operation === "get_track_item_components")
    return trackItemComponents(payload);
  if (message.operation === "get_editing_capabilities") {
    return {
      videoEffects: await ppro.VideoFilterFactory.getMatchNames(),
      videoTransitions:
        await ppro.TransitionFactory.getVideoTransitionMatchNames(),
      audioEffects: await ppro.AudioFilterFactory.getDisplayNames(),
      ameInstalled: ppro.EncoderManager.getManager().isAMEInstalled,
    };
  }
  if (message.operation === "get_request_journal") {
    await ensureJournal();
    const limit = Number(payload.limit ?? 100);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500)
      throw new Error("journal limit must be an integer from 1 to 500");
    return requestJournal.list(limit);
  }
  if (message.operation === "save_project") {
    if (payload.confirm !== true)
      throw new Error("save_project requires confirm: true");
    const { before, project } = await timelineMutationContext(payload);
    await assertMutationBoundary(before, payload);
    if (!(await project.save()))
      throw new Error("Premiere did not save the project");
    return { saved: true, projectGuid: before.project.guid };
  }
  if (message.operation === "import_media_file")
    return importMediaFile(payload);
  if (message.operation === "remove_project_item")
    return removeProjectItem(payload);
  if (message.operation === "trim_track_item") return trimTrackItem(payload);
  if (message.operation === "insert_project_item")
    return insertProjectItem(payload);
  if (message.operation === "insert_mogrt") return insertMogrt(payload);
  if (message.operation === "move_track_item") return moveTrackItem(payload);
  if (message.operation === "clone_track_item") return cloneTrackItem(payload);
  if (message.operation === "remove_track_item")
    return removeTrackItem(payload);
  if (message.operation === "update_track_item")
    return updateTrackItem(payload);
  if (message.operation === "update_track") return updateTrack(payload);
  if (message.operation === "add_sequence_marker")
    return addSequenceMarker(payload);
  if (message.operation === "update_sequence_marker")
    return updateSequenceMarker(payload);
  if (message.operation === "move_sequence_marker")
    return moveSequenceMarker(payload);
  if (message.operation === "remove_sequence_marker")
    return removeSequenceMarker(payload);
  if (message.operation === "add_video_transition")
    return addVideoTransition(payload);
  if (message.operation === "remove_video_transition")
    return removeVideoTransition(payload);
  if (message.operation === "add_video_effect") return addVideoEffect(payload);
  if (message.operation === "remove_video_effect")
    return removeVideoEffect(payload);
  if (message.operation === "add_audio_effect") return addAudioEffect(payload);
  if (message.operation === "remove_audio_effect")
    return removeAudioEffect(payload);
  if (message.operation === "set_component_param")
    return setComponentParam(payload);
  if (message.operation === "set_component_keyframe")
    return setComponentKeyframe(payload);
  if (message.operation === "remove_component_keyframe")
    return removeComponentKeyframe(payload);
  if (message.operation === "create_sequence") return createSequence(payload);
  if (message.operation === "create_sequence_from_media")
    return createSequenceFromMedia(payload);
  if (message.operation === "delete_sequence")
    return changeSequenceState("delete", payload);
  if (message.operation === "activate_sequence")
    return changeSequenceState("activate", payload);
  if (message.operation === "open_sequence")
    return changeSequenceState("open", payload);
  if (message.operation === "close_sequence")
    return changeSequenceState("close", payload);
  if (message.operation === "clone_sequence") return cloneSequence(payload);
  if (message.operation === "create_subsequence")
    return createSubsequence(payload);
  if (message.operation === "set_sequence_bounds")
    return setSequenceBounds(payload);
  if (message.operation === "set_sequence_playhead")
    return setSequencePlayhead(payload);
  if (message.operation === "set_sequence_settings")
    return setSequenceSettings(payload);
  if (message.operation === "set_track_muted") return setTrackMuted(payload);
  if (message.operation === "detect_scene_edits")
    return detectSceneEdits(payload);
  if (message.operation === "create_bin") return createBin(payload, false);
  if (message.operation === "create_smart_bin") return createBin(payload, true);
  if (message.operation === "update_project_item")
    return updateProjectItem(payload);
  if (message.operation === "move_project_item")
    return moveProjectItem(payload);
  if (message.operation === "update_clip_media")
    return updateClipMedia(payload);
  if (message.operation === "create_subclip") return createSubclip(payload);
  if (message.operation === "set_clip_interpretation")
    return setClipInterpretation(payload);
  if (message.operation === "set_clip_bounds") return setClipBounds(payload);
  if (message.operation === "source_monitor_open_file")
    return sourceMonitorMutation("open-file", payload);
  if (message.operation === "source_monitor_open_item")
    return sourceMonitorMutation("open-item", payload);
  if (message.operation === "source_monitor_close")
    return sourceMonitorMutation("close", payload);
  if (message.operation === "source_monitor_set_position")
    return sourceMonitorMutation("position", payload);
  if (message.operation === "source_monitor_play")
    return sourceMonitorMutation("play", payload);
  if (message.operation === "import_clip_transcript")
    return importClipTranscript(payload);
  if (message.operation === "export_sequence") return exportSequence(payload);
  throw new Error(`Unsupported operation: ${String(message.operation)}`);
}

function send(target: WebSocket, value: unknown): void {
  if (target.readyState === WebSocket.OPEN) target.send(JSON.stringify(value));
}

function journalResult(result: unknown): {
  beforeRevision?: string;
  afterRevision?: string;
  beforeProjectItemsRevision?: string;
  afterProjectItemsRevision?: string;
  resultDigest: string;
} {
  const record =
    result && typeof result === "object"
      ? (result as Record<string, unknown>)
      : undefined;
  const timeline =
    record?.timeline && typeof record.timeline === "object"
      ? (record.timeline as Record<string, unknown>)
      : undefined;
  const revision =
    typeof timeline?.revision === "string"
      ? timeline.revision
      : typeof record?.revision === "string"
        ? record.revision
        : undefined;
  const projectItems =
    record?.projectItems && typeof record.projectItems === "object"
      ? (record.projectItems as Record<string, unknown>)
      : undefined;
  return {
    ...(revision ? { afterRevision: revision } : {}),
    ...(typeof projectItems?.revision === "string"
      ? { afterProjectItemsRevision: projectItems.revision }
      : {}),
    resultDigest: digestJournalValue(result),
  };
}

async function processRequest(
  target: WebSocket,
  message: PluginRequest,
): Promise<void> {
  const journaled = MUTATION_OPERATIONS.has(message.operation);
  let journalStarted = false;
  try {
    if (journaled) {
      await ensureJournal();
      const payload = message.payload;
      await requestJournal.begin({
        requestId: message.requestId,
        operation: message.operation,
        receivedAt: Date.now(),
        payloadDigest: digestJournalValue(payload),
        ...(typeof payload.expectedProjectGuid === "string"
          ? { projectGuid: payload.expectedProjectGuid }
          : {}),
        ...(typeof payload.expectedSequenceGuid === "string"
          ? { sequenceGuid: payload.expectedSequenceGuid }
          : {}),
        ...(typeof payload.expectedRevision === "string"
          ? {
              expectedRevision: payload.expectedRevision,
              beforeRevision: payload.expectedRevision,
            }
          : {}),
        ...(typeof payload.expectedProjectItemsRevision === "string"
          ? {
              expectedProjectItemsRevision:
                payload.expectedProjectItemsRevision,
              beforeProjectItemsRevision: payload.expectedProjectItemsRevision,
            }
          : {}),
      });
      journalStarted = true;
    }
    const result = await handleRequest(
      message,
      () => target.readyState === WebSocket.OPEN,
    );
    if (journalStarted) {
      try {
        await requestJournal.succeed(message.requestId, journalResult(result));
      } catch (journalError) {
        console.error("Could not persist successful request journal entry", {
          requestId: message.requestId,
          error:
            journalError instanceof Error
              ? journalError.message
              : String(journalError),
        });
      }
    }
    send(target, {
      type: "response",
      id: message.id,
      ok: true,
      result,
    } satisfies PluginResponse);
  } catch (error) {
    if (journalStarted) {
      try {
        const unknownOutcome = isRequestUnknownOutcomeError(error);
        await requestJournal.fail(
          message.requestId,
          error,
          isRequestDeadlineExpiredError(error)
            ? "expired"
            : unknownOutcome
              ? "unknown_outcome"
              : "failed",
          unknownOutcome && error.afterProjectItemsRevision
            ? {
                afterProjectItemsRevision: error.afterProjectItemsRevision,
                ...(error.afterRevision
                  ? { afterRevision: error.afterRevision }
                  : {}),
              }
            : unknownOutcome && error.afterRevision
              ? { afterRevision: error.afterRevision }
              : {},
        );
      } catch (journalError) {
        console.error("Could not persist failed request journal entry", {
          requestId: message.requestId,
          error:
            journalError instanceof Error
              ? journalError.message
              : String(journalError),
        });
      }
    }
    send(target, {
      type: "response",
      id: message.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    } satisfies PluginResponse);
  }
  send(target, {
    type: "session_updated",
    session: await sessionDescription(),
  });
}

async function connect(): Promise<void> {
  if (socket && socket.readyState < WebSocket.CLOSING) return;
  setStatus("Connecting to local broker…");
  const target = new WebSocket(`ws://localhost:${__GATEWAY_PORT__}/plugin`);
  socket = target;
  let requestTail = Promise.resolve();
  target.onopen = async () => {
    retryMs = 250;
    try {
      await ensureJournal();
    } catch (error) {
      journalStatus = "unavailable";
      console.error("Gateway for Premiere request journal unavailable", error);
    }
    send(target, {
      type: "hello",
      token: __GATEWAY_TOKEN__,
      session: await sessionDescription(),
    });
  };
  target.onmessage = (event) => {
    try {
      const message = JSON.parse(String(event.data)) as
        PluginConnected | PluginRequest;
      if (message.type === "connected") {
        setStatus("Connected");
        return;
      }
      if (message.type !== "request") return;
      requestTail = requestTail.then(
        () => processRequest(target, message),
        () => processRequest(target, message),
      );
    } catch (error) {
      setStatus(
        `Protocol error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  target.onerror = (event) => {
    console.error("Gateway for Premiere WebSocket error", event);
    setStatus("Broker connection failed");
  };
  target.onclose = (event) => {
    console.error("Gateway for Premiere WebSocket closed", {
      code: event.code,
      reason: event.reason,
      wasClean: event.wasClean,
    });
    if (socket === target) socket = undefined;
    setStatus("Reconnecting…");
    setTimeout(() => void connect(), retryMs);
    retryMs = Math.min(retryMs * 2, 5000);
  };
}

entrypoints.setup({
  panels: {
    // Adobe's current UXP declaration models panels as an array, while Premiere
    // resolves this object by the manifest entrypoint ID.
    // @ts-expect-error Adobe UXP panel entrypoint declaration mismatch
    gatewayPanel: {
      show() {
        void connect();
      },
    },
  },
});

window.addEventListener("load", () => void connect());
