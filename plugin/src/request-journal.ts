import type { PluginOperation } from "../../src/shared/protocol";

export const REQUEST_JOURNAL_VERSION = 1;
export const REQUEST_JOURNAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const REQUEST_JOURNAL_MAX_TERMINAL_ENTRIES = 500;

export type RequestJournalStatus =
  | "received"
  | "running"
  | "succeeded"
  | "failed"
  | "expired"
  | "unknown_outcome";

export interface RequestJournalEntry {
  requestId: string;
  operation: PluginOperation;
  status: RequestJournalStatus;
  receivedAt: number;
  startedAt?: number;
  finishedAt?: number;
  projectGuid?: string;
  sequenceGuid?: string;
  expectedRevision?: string;
  expectedProjectItemsRevision?: string;
  payloadDigest: string;
  beforeRevision?: string;
  afterRevision?: string;
  beforeProjectItemsRevision?: string;
  afterProjectItemsRevision?: string;
  resultDigest?: string;
  errorCode?:
    | "deadline_expired"
    | "operation_failed"
    | "plugin_session_ended"
    | "outcome_unconfirmed";
  errorDigest?: string;
}

interface RequestJournalDocument {
  version: typeof REQUEST_JOURNAL_VERSION;
  updatedAt: number;
  entries: RequestJournalEntry[];
}

export interface RequestJournalPersistence {
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
}

export class RequestDeadlineExpiredError extends Error {
  constructor() {
    super("Premiere Gateway request expired before execution");
    this.name = "RequestDeadlineExpiredError";
  }
}

export function isRequestDeadlineExpiredError(
  error: unknown,
): error is RequestDeadlineExpiredError {
  return error instanceof RequestDeadlineExpiredError;
}

export class RequestUnknownOutcomeError extends Error {
  constructor(
    message = "Premiere Gateway operation outcome is unknown",
    readonly afterProjectItemsRevision?: string,
    readonly afterRevision?: string,
  ) {
    super(message);
    this.name = "RequestUnknownOutcomeError";
  }
}

export function isRequestUnknownOutcomeError(
  error: unknown,
): error is RequestUnknownOutcomeError {
  return error instanceof RequestUnknownOutcomeError;
}

export interface BeginRequestJournalEntry {
  requestId: string;
  operation: PluginOperation;
  receivedAt: number;
  projectGuid?: string;
  sequenceGuid?: string;
  expectedRevision?: string;
  expectedProjectItemsRevision?: string;
  beforeRevision?: string;
  beforeProjectItemsRevision?: string;
  payloadDigest: string;
}

export interface CompleteRequestJournalEntry {
  beforeRevision?: string;
  afterRevision?: string;
  beforeProjectItemsRevision?: string;
  afterProjectItemsRevision?: string;
  resultDigest?: string;
}

export function isMissingJournalEntryError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /not found|could not find|does not exist|no such/i.test(message);
}

const TERMINAL_STATUSES = new Set<RequestJournalStatus>([
  "succeeded",
  "failed",
  "expired",
]);

function isStatus(value: unknown): value is RequestJournalStatus {
  return new Set<RequestJournalStatus>([
    "received",
    "running",
    "succeeded",
    "failed",
    "expired",
    "unknown_outcome",
  ]).has(value as RequestJournalStatus);
}

function parseDocument(value: string): RequestJournalDocument {
  const parsed = JSON.parse(value) as Partial<RequestJournalDocument>;
  if (
    parsed.version !== REQUEST_JOURNAL_VERSION ||
    !Number.isFinite(parsed.updatedAt) ||
    !Array.isArray(parsed.entries)
  ) {
    throw new Error("Premiere Gateway request journal has an invalid schema");
  }
  for (const entry of parsed.entries) {
    if (
      !entry ||
      typeof entry.requestId !== "string" ||
      typeof entry.operation !== "string" ||
      !isStatus(entry.status) ||
      !Number.isFinite(entry.receivedAt) ||
      typeof entry.payloadDigest !== "string"
    ) {
      throw new Error("Premiere Gateway request journal has an invalid entry");
    }
  }
  return parsed as RequestJournalDocument;
}

function terminal(entry: RequestJournalEntry): boolean {
  return TERMINAL_STATUSES.has(entry.status);
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 500);
}

export function digestJournalValue(value: unknown): string {
  const input = JSON.stringify(value);
  let result = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    result ^= input.charCodeAt(index);
    result = Math.imul(result, 0x01000193);
  }
  return (result >>> 0).toString(16).padStart(8, "0");
}

export class RequestJournal {
  private entries: RequestJournalEntry[] = [];
  private initialized = false;

  constructor(
    private readonly persistence: RequestJournalPersistence,
    private readonly now: () => number = Date.now,
  ) {}

  async initialize(): Promise<void> {
    if (this.initialized) return;
    const stored = await this.persistence.read();
    this.entries = stored ? parseDocument(stored).entries : [];
    const now = this.now();
    let changed = this.prune(now);
    for (const entry of this.entries) {
      const legacyEntry = entry as RequestJournalEntry & { error?: unknown };
      if (legacyEntry.error !== undefined) {
        entry.errorCode =
          entry.status === "expired"
            ? "deadline_expired"
            : entry.status === "unknown_outcome"
              ? "plugin_session_ended"
              : "operation_failed";
        entry.errorDigest = digestJournalValue(String(legacyEntry.error));
        delete legacyEntry.error;
        changed = true;
      }
      if (entry.status === "received" || entry.status === "running") {
        entry.status = "unknown_outcome";
        entry.finishedAt = now;
        entry.errorCode = "plugin_session_ended";
        changed = true;
      }
    }
    if (changed) await this.persist();
    this.initialized = true;
  }

  async begin(input: BeginRequestJournalEntry): Promise<void> {
    await this.initialize();
    if (this.prune(input.receivedAt)) await this.persist();
    const existing = this.entries.find(
      (entry) => entry.requestId === input.requestId,
    );
    if (existing) {
      throw new Error(
        `Request ${input.requestId} is already ${existing.status}; it will not be replayed`,
      );
    }
    this.entries.push({ ...input, status: "received" });
    await this.persist();
    const entry = this.required(input.requestId);
    entry.status = "running";
    entry.startedAt = this.now();
    await this.persist();
  }

  async succeed(
    requestId: string,
    result: CompleteRequestJournalEntry,
  ): Promise<void> {
    const entry = this.required(requestId);
    entry.status = "succeeded";
    entry.finishedAt = this.now();
    Object.assign(entry, result);
    this.prune(entry.finishedAt);
    await this.persist();
  }

  async fail(
    requestId: string,
    error: unknown,
    status: "failed" | "expired" | "unknown_outcome" = "failed",
    result: CompleteRequestJournalEntry = {},
  ): Promise<void> {
    const entry = this.required(requestId);
    entry.status = status;
    entry.finishedAt = this.now();
    entry.errorCode =
      status === "expired"
        ? "deadline_expired"
        : status === "unknown_outcome"
          ? "outcome_unconfirmed"
          : "operation_failed";
    entry.errorDigest = digestJournalValue(errorMessage(error));
    Object.assign(entry, result);
    this.prune(entry.finishedAt);
    await this.persist();
  }

  async list(limit = 100): Promise<{
    version: number;
    retentionMs: number;
    entries: RequestJournalEntry[];
  }> {
    await this.initialize();
    if (this.prune(this.now())) await this.persist();
    const bounded = Math.max(1, Math.min(500, Math.floor(limit)));
    return {
      version: REQUEST_JOURNAL_VERSION,
      retentionMs: REQUEST_JOURNAL_RETENTION_MS,
      entries: this.entries
        .slice()
        .sort((left, right) => right.receivedAt - left.receivedAt)
        .slice(0, bounded)
        .map((entry) => ({ ...entry })),
    };
  }

  get size(): number {
    return this.entries.length;
  }

  private required(requestId: string): RequestJournalEntry {
    const entry = this.entries.find((item) => item.requestId === requestId);
    if (!entry)
      throw new Error(`Request journal entry not found: ${requestId}`);
    return entry;
  }

  private prune(now: number): boolean {
    const before = this.entries.length;
    const retained = this.entries.filter(
      (entry) =>
        !terminal(entry) ||
        (entry.finishedAt || entry.receivedAt) >=
          now - REQUEST_JOURNAL_RETENTION_MS,
    );
    const terminalEntries = retained
      .filter(terminal)
      .sort(
        (left, right) =>
          (right.finishedAt || right.receivedAt) -
          (left.finishedAt || left.receivedAt),
      );
    const terminalIds = new Set(
      terminalEntries
        .slice(0, REQUEST_JOURNAL_MAX_TERMINAL_ENTRIES)
        .map((entry) => entry.requestId),
    );
    this.entries = retained.filter(
      (entry) => !terminal(entry) || terminalIds.has(entry.requestId),
    );
    return this.entries.length !== before;
  }

  private persist(): Promise<void> {
    const document: RequestJournalDocument = {
      version: REQUEST_JOURNAL_VERSION,
      updatedAt: this.now(),
      entries: this.entries,
    };
    return this.persistence.write(JSON.stringify(document));
  }
}
