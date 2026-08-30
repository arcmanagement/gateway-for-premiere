import assert from "node:assert/strict";
import test from "node:test";
import {
  digestJournalValue,
  isMissingJournalEntryError,
  isRequestDeadlineExpiredError,
  isRequestUnknownOutcomeError,
  RequestJournal,
  RequestDeadlineExpiredError,
  RequestUnknownOutcomeError,
  REQUEST_JOURNAL_MAX_TERMINAL_ENTRIES,
  REQUEST_JOURNAL_RETENTION_MS,
  type RequestJournalPersistence,
} from "../plugin/src/request-journal.js";

test("UXP's first-run missing-entry error is recognized", () => {
  assert.equal(
    isMissingJournalEntryError(
      new Error(
        "Could not find an entry of 'plugin-data:/request-journal-v1.json'",
      ),
    ),
    true,
  );
});

test("deadline classification uses a typed error, not message text", () => {
  assert.equal(
    isRequestDeadlineExpiredError(new RequestDeadlineExpiredError()),
    true,
  );
  assert.equal(
    isRequestDeadlineExpiredError(
      new Error("Video effect is not installed: ExpiredEffect"),
    ),
    false,
  );
});

test("unknown outcome classification uses a typed error, not message text", () => {
  const typed = new RequestUnknownOutcomeError(
    "outcome could not be confirmed",
    "items-revision-2",
  );
  assert.equal(isRequestUnknownOutcomeError(typed), true);
  assert.equal(typed.afterProjectItemsRevision, "items-revision-2");
  assert.equal(
    isRequestUnknownOutcomeError(new Error("outcome could not be confirmed")),
    false,
  );
});

class MemoryPersistence implements RequestJournalPersistence {
  constructor(public value: string | null = null) {}

  async read(): Promise<string | null> {
    return this.value;
  }

  async write(value: string): Promise<void> {
    this.value = value;
  }
}

test("unfinished requests become unknown outcomes and are never replayed", async () => {
  const now = 2_000_000;
  const persistence = new MemoryPersistence(
    JSON.stringify({
      version: 1,
      updatedAt: now - 1_000,
      entries: [
        {
          requestId: "request-running",
          operation: "trim_track_item",
          status: "running",
          receivedAt: now - 1_000,
          startedAt: now - 900,
          payloadDigest: "12345678",
        },
      ],
    }),
  );
  const journal = new RequestJournal(persistence, () => now);
  await journal.initialize();
  const snapshot = await journal.list();
  assert.equal(snapshot.entries[0]?.status, "unknown_outcome");
  await assert.rejects(
    journal.begin({
      requestId: "request-running",
      operation: "trim_track_item",
      receivedAt: now,
      payloadDigest: "12345678",
    }),
    /already unknown_outcome; it will not be replayed/,
  );
});

test("terminal entries expire while unresolved outcomes are retained", async () => {
  const now = 20_000_000_000;
  const old = now - REQUEST_JOURNAL_RETENTION_MS - 1;
  const persistence = new MemoryPersistence(
    JSON.stringify({
      version: 1,
      updatedAt: old,
      entries: [
        {
          requestId: "request-succeeded",
          operation: "save_project",
          status: "succeeded",
          receivedAt: old,
          finishedAt: old,
          payloadDigest: "11111111",
        },
        {
          requestId: "request-unknown",
          operation: "trim_track_item",
          status: "unknown_outcome",
          receivedAt: old,
          finishedAt: old,
          payloadDigest: "22222222",
        },
      ],
    }),
  );
  const journal = new RequestJournal(persistence, () => now);
  await journal.initialize();
  assert.deepEqual(
    (await journal.list()).entries.map((entry) => entry.requestId),
    ["request-unknown"],
  );
});

test("journal stores digests and metadata without raw payload values", async () => {
  let now = 3_000_000;
  const persistence = new MemoryPersistence();
  const journal = new RequestJournal(persistence, () => now);
  const sensitivePath = "/private/example/customer-video.mov";
  await journal.begin({
    requestId: "request-private",
    operation: "export_sequence",
    receivedAt: now,
    projectGuid: "project-1",
    sequenceGuid: "sequence-1",
    expectedRevision: "revision-1",
    expectedProjectItemsRevision: "items-revision-1",
    beforeProjectItemsRevision: "items-revision-1",
    payloadDigest: digestJournalValue({ outputFile: sensitivePath }),
  });
  now += 10;
  await journal.succeed("request-private", {
    beforeRevision: "revision-1",
    afterRevision: "revision-1",
    afterProjectItemsRevision: "items-revision-2",
    resultDigest: digestJournalValue({ exported: true }),
  });

  assert.ok(persistence.value);
  assert.doesNotMatch(persistence.value, /customer-video|private\/example/);
  const entry = (await journal.list()).entries[0];
  assert.equal(entry?.status, "succeeded");
  assert.equal(entry?.afterRevision, "revision-1");
  assert.equal(entry?.beforeProjectItemsRevision, "items-revision-1");
  assert.equal(entry?.afterProjectItemsRevision, "items-revision-2");
});

test("explicit unknown outcomes remain unresolved with a safe error code", async () => {
  const persistence = new MemoryPersistence();
  const journal = new RequestJournal(persistence, () => 3_250_000);
  await journal.begin({
    requestId: "request-unknown-import",
    operation: "import_media_file",
    receivedAt: 3_250_000,
    expectedProjectItemsRevision: "items-revision-1",
    beforeProjectItemsRevision: "items-revision-1",
    payloadDigest: "12345678",
  });
  await journal.fail(
    "request-unknown-import",
    new RequestUnknownOutcomeError("private path omitted"),
    "unknown_outcome",
    {
      afterProjectItemsRevision: "items-revision-2",
      afterRevision: "timeline-revision-2",
    },
  );

  const entry = (await journal.list()).entries[0];
  assert.equal(entry?.status, "unknown_outcome");
  assert.equal(entry?.errorCode, "outcome_unconfirmed");
  assert.equal(entry?.beforeProjectItemsRevision, "items-revision-1");
  assert.equal(entry?.afterProjectItemsRevision, "items-revision-2");
  assert.equal(entry?.afterRevision, "timeline-revision-2");
});

test("journal failure metadata never stores raw exception values", async () => {
  let now = 3_500_000;
  const persistence = new MemoryPersistence();
  const journal = new RequestJournal(persistence, () => now);
  const sensitivePath = "/private/example/customer-video.mov";
  await journal.begin({
    requestId: "request-private-failure",
    operation: "export_sequence",
    receivedAt: now,
    payloadDigest: "12345678",
  });
  now += 10;
  await journal.fail(
    "request-private-failure",
    new Error(`Export failed for ${sensitivePath}`),
  );

  assert.ok(persistence.value);
  assert.doesNotMatch(persistence.value, /customer-video|private\/example/);
  const entry = (await journal.list()).entries[0];
  assert.equal(entry?.errorCode, "operation_failed");
  assert.match(entry?.errorDigest || "", /^[0-9a-f]{8}$/);
});

test("list prunes expired terminal entries added after initialization", async () => {
  let now = 4_000_000;
  const persistence = new MemoryPersistence();
  const journal = new RequestJournal(persistence, () => now);
  await journal.begin({
    requestId: "request-expiring",
    operation: "save_project",
    receivedAt: now,
    payloadDigest: "12345678",
  });
  await journal.succeed("request-expiring", {});
  now += REQUEST_JOURNAL_RETENTION_MS + 1;

  assert.deepEqual((await journal.list()).entries, []);
  assert.doesNotMatch(persistence.value || "", /request-expiring/);
});

test("begin prunes an expired ID before duplicate detection", async () => {
  let now = 5_000_000;
  const persistence = new MemoryPersistence();
  const journal = new RequestJournal(persistence, () => now);
  const input = {
    requestId: "request-reusable-after-retention",
    operation: "save_project" as const,
    receivedAt: now,
    payloadDigest: "12345678",
  };
  await journal.begin(input);
  await journal.succeed(input.requestId, {});
  now += REQUEST_JOURNAL_RETENTION_MS + 1;

  await journal.begin({ ...input, receivedAt: now });
  assert.equal((await journal.list()).entries[0]?.status, "running");
});

test("terminal transitions enforce the maximum retained entry count", async () => {
  let now = 6_000_000;
  const persistence = new MemoryPersistence();
  const journal = new RequestJournal(persistence, () => now);
  for (
    let index = 0;
    index < REQUEST_JOURNAL_MAX_TERMINAL_ENTRIES + 1;
    index += 1
  ) {
    const requestId = `request-${index}`;
    await journal.begin({
      requestId,
      operation: "save_project",
      receivedAt: now,
      payloadDigest: "12345678",
    });
    await journal.succeed(requestId, {});
    now += 1;
  }

  const stored = JSON.parse(persistence.value || "{}") as {
    entries?: unknown[];
  };
  assert.equal(stored.entries?.length, REQUEST_JOURNAL_MAX_TERMINAL_ENTRIES);
});

test("a journal write failure blocks a request before it can run", async () => {
  const persistence: RequestJournalPersistence = {
    read: async () => null,
    write: async () => {
      throw new Error("disk unavailable");
    },
  };
  const journal = new RequestJournal(persistence, () => 4_000_000);
  await assert.rejects(
    journal.begin({
      requestId: "request-blocked",
      operation: "trim_track_item",
      receivedAt: 4_000_000,
      payloadDigest: "12345678",
    }),
    /disk unavailable/,
  );
});
