export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type MediaType = "video" | "audio";

export const DEFAULT_PLUGIN_TIMEOUT_MS = 30_000;
export const EXPORT_PLUGIN_TIMEOUT_MS = 10 * 60_000;

export interface ConnectedSession {
  sessionId: string;
  pluginVersion: string;
  premiereVersion: string;
  projectGuid?: string;
  projectName?: string;
  sequenceGuid?: string;
  sequenceName?: string;
  journalStatus?: "ready" | "unavailable";
  journalEntries?: number;
}

export interface TimelineItem {
  ref: string;
  mediaType: MediaType;
  trackIndex: number;
  itemIndex: number;
  name: string;
  startSeconds: number;
  endSeconds: number;
  inPointSeconds: number;
  outPointSeconds: number;
  disabled: boolean;
  speed: number;
  reversed: boolean;
  componentsRevision: string;
  componentsReliability: "complete" | "unavailable";
  projectItemId?: string;
}

export interface TimelineTransition {
  ref: string;
  mediaType: MediaType;
  trackIndex: number;
  transitionIndex: number;
  name: string | null;
  matchName: string | null;
  startSeconds: number | null;
  endSeconds: number | null;
}

export interface TimelineTrack {
  mediaType: MediaType;
  index: number;
  id: number;
  name: string;
  muted: boolean;
  items: TimelineItem[];
  transitions: TimelineTransition[];
}

export interface CaptionTrackSnapshot {
  index: number;
  id: number;
  name: string;
  muted: boolean;
  mediaTypeGuid: string;
  itemCount: number | null;
  itemsReliability: "count-only" | "unavailable";
}

export interface TimelineMarker {
  guid: string;
  name: string;
  type: string;
  startSeconds: number;
  durationSeconds: number;
  comments: string;
  colorIndex: number;
  webLinkRevision: string;
}

export interface TimelineSnapshot {
  project: {
    guid: string;
    name: string;
    path: string;
  };
  sequence: {
    guid: string;
    name: string;
  };
  revision: string;
  revisionReliability:
    | "complete"
    | "opaque-transitions"
    | "opaque-captions"
    | "incomplete-components"
    | "multiple-incomplete";
  tracks: TimelineTrack[];
  captionTracks: CaptionTrackSnapshot[];
  markers: TimelineMarker[];
}

export interface ProjectItemSnapshot {
  id: string;
  name: string;
  type: number;
  kind: "bin" | "clip" | "file" | "sequence" | "other";
  mediaPath?: string;
  children?: ProjectItemSnapshot[];
}

export interface ProjectItemsSnapshot {
  projectGuid: string;
  revision: string;
  items: ProjectItemSnapshot[];
}

export interface EditingSnapshot {
  capturedAtEpochMs: number;
  stability: "stable";
  projectItems: ProjectItemsSnapshot;
  timeline: TimelineSnapshot;
}

export interface ComponentParamSnapshot {
  index: number;
  displayName: string;
  value: JsonValue;
  valueReliability: "complete" | "unavailable";
  timeVarying: boolean;
  keyframes: Array<{
    timeSeconds: number;
    value: JsonValue;
    temporalInterpolationMode: number;
  }>;
}

export interface ComponentSnapshot {
  index: number;
  displayName: string;
  matchName: string;
  params: ComponentParamSnapshot[];
}

export type PluginOperation =
  | "get_active_project"
  | "get_project_recovery"
  | "get_editing_snapshot"
  | "get_active_sequence"
  | "list_sequences"
  | "get_sequence_settings"
  | "get_project_items"
  | "get_project_item_details"
  | "find_project_items_by_media_path"
  | "get_source_monitor"
  | "query_transcript_languages"
  | "get_clip_transcript"
  | "get_track_item_components"
  | "get_editing_capabilities"
  | "get_request_journal"
  | "save_project"
  | "import_media_file"
  | "remove_project_item"
  | "trim_track_item"
  | "insert_project_item"
  | "move_track_item"
  | "clone_track_item"
  | "remove_track_item"
  | "update_track_item"
  | "update_track"
  | "insert_mogrt"
  | "add_sequence_marker"
  | "update_sequence_marker"
  | "move_sequence_marker"
  | "remove_sequence_marker"
  | "add_video_transition"
  | "remove_video_transition"
  | "add_video_effect"
  | "remove_video_effect"
  | "add_audio_effect"
  | "remove_audio_effect"
  | "set_component_param"
  | "set_component_keyframe"
  | "remove_component_keyframe"
  | "export_sequence"
  | "create_sequence"
  | "create_sequence_from_media"
  | "delete_sequence"
  | "activate_sequence"
  | "open_sequence"
  | "close_sequence"
  | "clone_sequence"
  | "create_subsequence"
  | "set_sequence_bounds"
  | "set_sequence_playhead"
  | "set_sequence_settings"
  | "set_track_muted"
  | "detect_scene_edits"
  | "create_bin"
  | "create_smart_bin"
  | "update_project_item"
  | "move_project_item"
  | "update_clip_media"
  | "create_subclip"
  | "set_clip_interpretation"
  | "set_clip_bounds"
  | "source_monitor_open_file"
  | "source_monitor_open_item"
  | "source_monitor_close"
  | "source_monitor_set_position"
  | "source_monitor_play"
  | "import_clip_transcript";

export const READ_OPERATIONS = new Set<PluginOperation>([
  "get_active_project",
  "get_project_recovery",
  "get_editing_snapshot",
  "get_active_sequence",
  "list_sequences",
  "get_sequence_settings",
  "get_project_items",
  "get_project_item_details",
  "find_project_items_by_media_path",
  "get_source_monitor",
  "query_transcript_languages",
  "get_clip_transcript",
  "get_track_item_components",
  "get_editing_capabilities",
  "get_request_journal",
]);

export const MUTATION_OPERATIONS = new Set<PluginOperation>([
  "save_project",
  "import_media_file",
  "remove_project_item",
  "trim_track_item",
  "insert_project_item",
  "move_track_item",
  "clone_track_item",
  "remove_track_item",
  "update_track_item",
  "update_track",
  "insert_mogrt",
  "add_sequence_marker",
  "update_sequence_marker",
  "move_sequence_marker",
  "remove_sequence_marker",
  "add_video_transition",
  "remove_video_transition",
  "add_video_effect",
  "remove_video_effect",
  "add_audio_effect",
  "remove_audio_effect",
  "set_component_param",
  "set_component_keyframe",
  "remove_component_keyframe",
  "export_sequence",
  "create_sequence",
  "create_sequence_from_media",
  "delete_sequence",
  "activate_sequence",
  "open_sequence",
  "close_sequence",
  "clone_sequence",
  "create_subsequence",
  "set_sequence_bounds",
  "set_sequence_playhead",
  "set_sequence_settings",
  "set_track_muted",
  "detect_scene_edits",
  "create_bin",
  "create_smart_bin",
  "update_project_item",
  "move_project_item",
  "update_clip_media",
  "create_subclip",
  "set_clip_interpretation",
  "set_clip_bounds",
  "source_monitor_open_file",
  "source_monitor_open_item",
  "source_monitor_close",
  "source_monitor_set_position",
  "source_monitor_play",
  "import_clip_transcript",
]);

export type ApprovalMode = "ask" | "auto" | "bypass";

export const AUTO_APPROVED_MUTATION_OPERATIONS = new Set<PluginOperation>([
  "update_track",
  "add_sequence_marker",
  "update_sequence_marker",
  "move_sequence_marker",
]);

export interface PluginHello {
  type: "hello";
  token: string;
  session: ConnectedSession;
}

export interface PluginConnected {
  type: "connected";
}

export interface PluginSessionUpdated {
  type: "session_updated";
  session: ConnectedSession;
}

export interface PluginRequest {
  type: "request";
  id: string;
  operation: PluginOperation;
  payload: Record<string, unknown>;
  deadlineEpochMs: number;
  requestId: string;
}

export interface PluginResponse {
  type: "response";
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface RpcRequest {
  operation: PluginOperation;
  sessionId?: string;
  requestId?: string;
  arguments: Record<string, unknown>;
}

export interface RpcResponse {
  ok: boolean;
  result?: unknown;
  error?: string;
  requestId?: string;
}
