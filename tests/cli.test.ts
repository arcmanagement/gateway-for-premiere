import assert from "node:assert/strict";
import type { spawnSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCli } from "../src/cli/index.js";
import { DAEMON_SERVICE_LABEL } from "../src/cli/daemon-service.js";
import { GATEWAY_PROTOCOL_TOKEN } from "../src/cli/config.js";

function useFixedProtocolToken(context: test.TestContext): void {
  void context;
  assert.equal(GATEWAY_PROTOCOL_TOKEN, "premiere-gateway");
}

test("CLI help keeps internal routing fixed and has no per-call Plugin launcher", async () => {
  let text = "";
  await runCli(["--help"], (value) => {
    text += value;
  });
  assert.doesNotMatch(text, /--port/);
  assert.doesNotMatch(text, /plugin start/);
  assert.match(text, /daemon install/);
  assert.match(text, /premiere-gateway doctor/);
  assert.match(text, /premiere-gateway snapshot/);
  assert.match(text, /transition add.*--match-name NAME/);
});

test("RPC calls rely on the broker end-to-end deadline", async (context) => {
  useFixedProtocolToken(context);
  let signal: AbortSignal | null | undefined;
  const fakeFetch = (async (_input, init) => {
    signal = init?.signal;
    return new Response(JSON.stringify({ ok: true, result: {} }), {
      status: 200,
    });
  }) as typeof fetch;
  await runCli(["project"], () => undefined, { fetch: fakeFetch });
  assert.equal(signal, undefined);
});

test("mutation network failures retain the request ID for reconciliation", async (context) => {
  useFixedProtocolToken(context);
  const fakeFetch = (async () => {
    throw new Error("connection dropped after send");
  }) as typeof fetch;

  await assert.rejects(
    runCli(
      [
        "project",
        "save",
        "--expect-project",
        "project-1",
        "--request-id",
        "request-network-failure-1",
        "--confirm",
      ],
      () => undefined,
      { fetch: fakeFetch },
    ),
    /connection dropped after send \(request request-network-failure-1\)/,
  );
});

test("trim forwards an explicit incomplete-revision override", async (context) => {
  useFixedProtocolToken(context);
  let request: Record<string, unknown> = {};
  const fakeFetch = (async (_input, init) => {
    request = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ ok: true, result: {} }), {
      status: 200,
    });
  }) as typeof fetch;
  await runCli(
    [
      "timeline",
      "trim",
      "--item-ref",
      "video:0:0",
      "--end-seconds",
      "4.5",
      "--allow-incomplete-revision",
      "true",
      "--request-id",
      "request-trim-1",
      "--expect-project",
      "project-1",
      "--expect-sequence",
      "sequence-1",
      "--expect-revision",
      "revision-1",
      "--confirm",
    ],
    () => undefined,
    { fetch: fakeFetch },
  );
  assert.deepEqual(request, {
    operation: "trim_track_item",
    requestId: "request-trim-1",
    arguments: {
      confirm: true,
      itemRef: "video:0:0",
      expectedProjectGuid: "project-1",
      expectedSequenceGuid: "sequence-1",
      expectedRevision: "revision-1",
      allowIncompleteRevision: true,
      endSeconds: 4.5,
    },
  });
});

test("status reports the connected Plugin session", async (context) => {
  useFixedProtocolToken(context);
  const fakeFetch = (async (input, init) => {
    assert.equal(String(input), "http://127.0.0.1:2196/health");
    assert.equal(
      (init?.headers as Record<string, string>)["x-premiere-gateway-token"],
      "premiere-gateway",
    );
    return new Response(
      JSON.stringify({ ok: true, sessions: [{ sessionId: "premiere-1" }] }),
      { status: 200 },
    );
  }) as typeof fetch;
  let text = "";
  await runCli(
    ["--port", "2196", "status"],
    (value) => {
      text += value;
    },
    { fetch: fakeFetch },
  );
  assert.deepEqual(JSON.parse(text), {
    ok: true,
    sessions: [{ sessionId: "premiere-1" }],
  });
});

test("status returns diagnostic JSON when the broker is unavailable", async (context) => {
  useFixedProtocolToken(context);
  const fakeFetch = (async () => {
    throw new Error("connection refused");
  }) as typeof fetch;
  let text = "";
  await runCli(
    ["status"],
    (value) => {
      text += value;
    },
    { fetch: fakeFetch },
  );
  const result = JSON.parse(text) as {
    ok: boolean;
    port: number;
    error: string;
  };
  assert.equal(result.ok, false);
  assert.equal(result.port, 1966);
  assert.match(result.error, /connection refused/);
});

test("doctor composes protocol access, daemon, broker, Premiere, and journal readiness", async (context) => {
  useFixedProtocolToken(context);
  const temporaryHome = await mkdtemp(
    path.join(os.tmpdir(), "premiere-gateway-doctor-"),
  );
  context.after(async () =>
    rm(temporaryHome, { recursive: true, force: true }),
  );
  const fakeFetch = (async () =>
    new Response(
      JSON.stringify({
        ok: true,
        sessions: [
          {
            sessionId: "premiere-1",
            pluginVersion: "0.1.0",
            premiereVersion: "26.3.2",
            journalStatus: "ready",
            journalEntries: 74,
            projectGuid: "project-1",
            projectName: "edit.prproj",
            sequenceGuid: "sequence-1",
            sequenceName: "Main",
          },
        ],
      }),
      { status: 200 },
    )) as typeof fetch;
  const fakeSpawn = (() => ({
    status: 113,
    stdout: "",
    stderr: "not loaded",
    pid: 0,
    output: [],
    signal: null,
  })) as typeof spawnSync;
  let text = "";

  await runCli(
    ["doctor"],
    (value) => {
      text += value;
    },
    {
      fetch: fakeFetch,
      daemonService: {
        platform: "darwin",
        uid: 501,
        homeDir: temporaryHome,
        spawn: fakeSpawn,
      },
    },
  );

  const report = JSON.parse(text) as {
    ok: boolean;
    access: { mode: string; token: string; loopbackOnly: boolean };
    readiness: { liveSession: boolean; persistentBroker: boolean };
    sessions: Array<{ project: { guid: string } }>;
  };
  assert.equal(report.ok, true);
  assert.deepEqual(report.access, {
    mode: "fixed-public-protocol-token",
    token: "premiere-gateway",
    loopbackOnly: true,
  });
  assert.deepEqual(report.readiness, {
    liveSession: true,
    persistentBrokerConfigured: false,
    persistentBroker: false,
    coldStartPlugin:
      "live Plugin session connected; cold-start provenance requires restart observation",
  });
  assert.equal(report.sessions[0]?.project.guid, "project-1");
});

test("project targets an explicit Premiere session", async (context) => {
  useFixedProtocolToken(context);
  let request: Record<string, unknown> = {};
  const fakeFetch = (async (_input, init) => {
    request = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({ ok: true, result: { guid: "project-1" } }),
      { status: 200 },
    );
  }) as typeof fetch;
  let text = "";
  await runCli(
    ["project", "--session", "premiere-1"],
    (value) => {
      text += value;
    },
    { fetch: fakeFetch },
  );
  assert.deepEqual(request, {
    operation: "get_active_project",
    arguments: {},
    sessionId: "premiere-1",
  });
  assert.deepEqual(JSON.parse(text), { guid: "project-1" });
});

test("snapshot requests one stable editing view with bounded project depth", async (context) => {
  useFixedProtocolToken(context);
  let request: Record<string, unknown> = {};
  const fakeFetch = (async (_input, init) => {
    request = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({
        ok: true,
        result: {
          stability: "stable",
          projectItems: { revision: "items-1" },
          timeline: { revision: "timeline-1" },
        },
      }),
      { status: 200 },
    );
  }) as typeof fetch;

  await runCli(
    ["snapshot", "--depth", "4", "--session", "premiere-1"],
    () => undefined,
    { fetch: fakeFetch },
  );

  assert.deepEqual(request, {
    operation: "get_editing_snapshot",
    arguments: { maxDepth: 4 },
    sessionId: "premiere-1",
  });
});

test("project recovery reads the active project's Auto Save location", async (context) => {
  useFixedProtocolToken(context);
  let request: Record<string, unknown> | undefined;
  const fakeFetch = (async (_input, init) => {
    request = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        ok: true,
        result: {
          projectGuid: "project-1",
          autoSaveFolder: "SameAsProject",
          autoSaveConfigurationReliability: "location-only",
        },
      }),
      { status: 200 },
    );
  }) as typeof fetch;

  await runCli(["project", "recovery", "--session", "session-1"], () => {}, {
    fetch: fakeFetch,
  });
  assert.deepEqual(request, {
    operation: "get_project_recovery",
    arguments: {},
    sessionId: "session-1",
  });
});

test("CLI maps an insert edit to the typed Premiere operation", async (context) => {
  useFixedProtocolToken(context);
  let request: Record<string, unknown> = {};
  const fakeFetch = (async (_input, init) => {
    request = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({ ok: true, result: { revision: "revision-2" } }),
      { status: 200 },
    );
  }) as typeof fetch;
  await runCli(
    [
      "timeline",
      "insert",
      "--project-item",
      "project-item-1",
      "--time-seconds",
      "5.5",
      "--video-track",
      "1",
      "--audio-track",
      "1",
      "--mode",
      "overwrite",
      "--limit-shift",
      "false",
      "--request-id",
      "request-insert-1",
      "--expect-project",
      "project-1",
      "--expect-sequence",
      "sequence-1",
      "--expect-revision",
      "revision-1",
      "--confirm",
    ],
    () => undefined,
    { fetch: fakeFetch },
  );
  assert.deepEqual(request, {
    operation: "insert_project_item",
    requestId: "request-insert-1",
    arguments: {
      confirm: true,
      expectedProjectGuid: "project-1",
      expectedSequenceGuid: "sequence-1",
      expectedRevision: "revision-1",
      projectItemId: "project-item-1",
      timeSeconds: 5.5,
      videoTrackIndex: 1,
      audioTrackIndex: 1,
      mode: "overwrite",
      limitShift: false,
    },
  });
});

test("CLI maps a revision-checked track rename", async (context) => {
  useFixedProtocolToken(context);
  let request: Record<string, unknown> = {};
  const fakeFetch = (async (_input, init) => {
    request = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({ ok: true, result: { revision: "revision-2" } }),
      { status: 200 },
    );
  }) as typeof fetch;

  await runCli(
    [
      "timeline",
      "track",
      "rename",
      "--media-type",
      "audio",
      "--track",
      "1",
      "--name",
      "Dialogue",
      "--request-id",
      "request-track-rename-1",
      "--expect-project",
      "project-1",
      "--expect-sequence",
      "sequence-1",
      "--expect-revision",
      "revision-1",
      "--confirm",
    ],
    () => undefined,
    { fetch: fakeFetch },
  );

  assert.deepEqual(request, {
    operation: "update_track",
    requestId: "request-track-rename-1",
    arguments: {
      confirm: true,
      expectedProjectGuid: "project-1",
      expectedSequenceGuid: "sequence-1",
      expectedRevision: "revision-1",
      mediaType: "audio",
      trackIndex: 1,
      name: "Dialogue",
    },
  });
});

test("CLI parses a typed component parameter value", async (context) => {
  useFixedProtocolToken(context);
  let request: Record<string, unknown> = {};
  const fakeFetch = (async (_input, init) => {
    request = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ ok: true, result: {} }), {
      status: 200,
    });
  }) as typeof fetch;
  await runCli(
    [
      "timeline",
      "effect",
      "set-param",
      "--item-ref",
      "video:0:0",
      "--component-index",
      "1",
      "--param-index",
      "0",
      "--value",
      '{"x":0.5,"y":0.5}',
      "--expect-project",
      "project-1",
      "--expect-sequence",
      "sequence-1",
      "--expect-revision",
      "revision-1",
      "--confirm",
    ],
    () => undefined,
    { fetch: fakeFetch },
  );
  const body = request as {
    operation?: string;
    arguments?: Record<string, unknown>;
  };
  assert.equal(body.operation, "set_component_param");
  assert.deepEqual(body.arguments?.value, { x: 0.5, y: 0.5 });
});

test("CLI maps typed component keyframe edits", async (context) => {
  useFixedProtocolToken(context);
  const requests: Record<string, unknown>[] = [];
  const fakeFetch = (async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ ok: true, result: {} }), {
      status: 200,
    });
  }) as typeof fetch;
  const expectations = [
    "--expect-project",
    "project-1",
    "--expect-sequence",
    "sequence-1",
    "--expect-revision",
    "revision-1",
    "--confirm",
  ];
  await runCli(
    [
      "timeline",
      "effect",
      "set-keyframe",
      "--item-ref",
      "video:0:0",
      "--component-index",
      "1",
      "--param-index",
      "0",
      "--time-seconds",
      "2.5",
      "--value",
      "50",
      "--interpolation",
      "hold",
      ...expectations,
    ],
    () => undefined,
    { fetch: fakeFetch },
  );
  await runCli(
    [
      "timeline",
      "effect",
      "remove-keyframe",
      "--item-ref",
      "video:0:0",
      "--component-index",
      "1",
      "--param-index",
      "0",
      "--time-seconds",
      "2.5",
      ...expectations,
    ],
    () => undefined,
    { fetch: fakeFetch },
  );
  assert.equal(requests[0]?.operation, "set_component_keyframe");
  assert.deepEqual(requests[0]?.arguments, {
    confirm: true,
    expectedProjectGuid: "project-1",
    expectedSequenceGuid: "sequence-1",
    expectedRevision: "revision-1",
    itemRef: "video:0:0",
    componentIndex: 1,
    paramIndex: 0,
    timeSeconds: 2.5,
    value: 50,
    interpolation: "hold",
  });
  assert.equal(requests[1]?.operation, "remove_component_keyframe");
  assert.deepEqual(requests[1]?.arguments, {
    confirm: true,
    expectedProjectGuid: "project-1",
    expectedSequenceGuid: "sequence-1",
    expectedRevision: "revision-1",
    itemRef: "video:0:0",
    componentIndex: 1,
    paramIndex: 0,
    timeSeconds: 2.5,
  });
});

test("CLI maps sequence marker add, update, move, and remove", async (context) => {
  useFixedProtocolToken(context);
  const requests: Record<string, unknown>[] = [];
  const fakeFetch = (async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ ok: true, result: {} }), {
      status: 200,
    });
  }) as typeof fetch;
  const expectations = [
    "--expect-project",
    "project-1",
    "--expect-sequence",
    "sequence-1",
    "--expect-revision",
    "revision-1",
    "--confirm",
  ];
  await runCli(
    [
      "timeline",
      "marker",
      "add",
      "--name",
      "Review",
      "--time-seconds",
      "1.25",
      "--duration-seconds",
      "0.5",
      "--comments",
      "Check pacing",
      "--type",
      "comment",
      ...expectations,
    ],
    () => undefined,
    { fetch: fakeFetch },
  );
  await runCli(
    [
      "timeline",
      "marker",
      "update",
      "--marker-guid",
      "marker-1",
      "--name",
      "Approved",
      "--comments",
      "Looks good",
      "--color-index",
      "5",
      ...expectations,
    ],
    () => undefined,
    { fetch: fakeFetch },
  );
  await runCli(
    [
      "timeline",
      "marker",
      "move",
      "--marker-guid",
      "marker-1",
      "--time-seconds",
      "2",
      ...expectations,
    ],
    () => undefined,
    { fetch: fakeFetch },
  );
  await runCli(
    [
      "timeline",
      "marker",
      "remove",
      "--marker-guid",
      "marker-1",
      ...expectations,
    ],
    () => undefined,
    { fetch: fakeFetch },
  );

  assert.deepEqual(
    requests.map(({ operation }) => operation),
    [
      "add_sequence_marker",
      "update_sequence_marker",
      "move_sequence_marker",
      "remove_sequence_marker",
    ],
  );
  assert.deepEqual(requests[0]?.arguments, {
    confirm: true,
    expectedProjectGuid: "project-1",
    expectedSequenceGuid: "sequence-1",
    expectedRevision: "revision-1",
    name: "Review",
    timeSeconds: 1.25,
    durationSeconds: 0.5,
    comments: "Check pacing",
    markerType: "comment",
  });
  assert.deepEqual(requests[1]?.arguments, {
    confirm: true,
    expectedProjectGuid: "project-1",
    expectedSequenceGuid: "sequence-1",
    expectedRevision: "revision-1",
    markerGuid: "marker-1",
    name: "Approved",
    comments: "Looks good",
    colorIndex: 5,
  });
});

test("CLI validates and maps MOGRT insertion", async (context) => {
  useFixedProtocolToken(context);
  const directory = await mkdtemp(path.join(os.tmpdir(), "premiere-mogrt-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const input = path.join(directory, "Basic Title.mogrt");
  await writeFile(input, "test mogrt");
  let request: Record<string, unknown> = {};
  const fakeFetch = (async (_input, init) => {
    request = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ ok: true, result: {} }), {
      status: 200,
    });
  }) as typeof fetch;
  await runCli(
    [
      "timeline",
      "mogrt",
      "insert",
      "--input",
      input,
      "--time-seconds",
      "1",
      "--video-track",
      "1",
      "--audio-track",
      "0",
      "--expect-project",
      "project-1",
      "--expect-sequence",
      "sequence-1",
      "--expect-revision",
      "revision-1",
      "--confirm",
    ],
    () => undefined,
    { fetch: fakeFetch },
  );
  assert.equal(request.operation, "insert_mogrt");
  assert.deepEqual(request.arguments, {
    confirm: true,
    expectedProjectGuid: "project-1",
    expectedSequenceGuid: "sequence-1",
    expectedRevision: "revision-1",
    inputFile: await realpath(input),
    timeSeconds: 1,
    videoTrackIndex: 1,
    audioTrackIndex: 0,
  });
});

test("CLI routes audio effects by display name", async (context) => {
  useFixedProtocolToken(context);
  const requests: Record<string, unknown>[] = [];
  const fakeFetch = (async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ ok: true, result: {} }), {
      status: 200,
    });
  }) as typeof fetch;
  const expectations = [
    "--expect-project",
    "project-1",
    "--expect-sequence",
    "sequence-1",
    "--expect-revision",
    "revision-1",
    "--confirm",
  ];
  await runCli(
    [
      "timeline",
      "effect",
      "add",
      "--item-ref",
      "audio:0:0",
      "--display-name",
      "Vocal Enhancer",
      ...expectations,
    ],
    () => undefined,
    { fetch: fakeFetch },
  );
  await runCli(
    [
      "timeline",
      "effect",
      "remove",
      "--item-ref",
      "audio:0:0",
      "--component-index",
      "2",
      ...expectations,
    ],
    () => undefined,
    { fetch: fakeFetch },
  );
  assert.equal(requests[0]?.operation, "add_audio_effect");
  assert.deepEqual(requests[0]?.arguments, {
    confirm: true,
    expectedProjectGuid: "project-1",
    expectedSequenceGuid: "sequence-1",
    expectedRevision: "revision-1",
    itemRef: "audio:0:0",
    displayName: "Vocal Enhancer",
  });
  assert.equal(requests[1]?.operation, "remove_audio_effect");
});

test("CLI does not mix video match names with audio display names", async (context) => {
  useFixedProtocolToken(context);
  await assert.rejects(
    runCli([
      "timeline",
      "effect",
      "add",
      "--item-ref",
      "audio:0:0",
      "--match-name",
      "AE.Audio",
      "--expect-project",
      "project-1",
      "--expect-sequence",
      "sequence-1",
      "--expect-revision",
      "revision-1",
      "--confirm",
    ]),
    /--display-name is required/,
  );
});

test("CLI validates export paths and maps a typed sequence export", async (context) => {
  useFixedProtocolToken(context);
  const directory = await mkdtemp(path.join(os.tmpdir(), "premiere-export-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const preset = path.join(directory, "preset.epr");
  const output = path.join(directory, "result.mov");
  await writeFile(preset, "test preset");
  const resolvedDirectory = await realpath(directory);
  let request: Record<string, unknown> = {};
  const fakeFetch = (async (_input, init) => {
    request = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ ok: true, result: {} }), {
      status: 200,
    });
  }) as typeof fetch;
  await runCli(
    [
      "sequence",
      "export",
      "--output",
      output,
      "--preset",
      preset,
      "--request-id",
      "request-export-1",
      "--expect-project",
      "project-1",
      "--expect-sequence",
      "sequence-1",
      "--expect-revision",
      "revision-1",
      "--confirm",
    ],
    () => undefined,
    { fetch: fakeFetch },
  );
  assert.deepEqual(request, {
    operation: "export_sequence",
    requestId: "request-export-1",
    arguments: {
      confirm: true,
      expectedProjectGuid: "project-1",
      expectedSequenceGuid: "sequence-1",
      expectedRevision: "revision-1",
      outputFile: path.join(resolvedDirectory, "result.mov"),
      presetFile: path.join(resolvedDirectory, "preset.epr"),
      exportFull: true,
    },
  });
});

test("CLI saves then creates an exclusive project backup", async (context) => {
  useFixedProtocolToken(context);
  const directory = await mkdtemp(path.join(os.tmpdir(), "premiere-backup-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, "project.prproj");
  const output = path.join(directory, "backup.prproj");
  await writeFile(source, "premiere project");
  const requests: Record<string, unknown>[] = [];
  const fakeFetch = (async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push(request);
    const result =
      request.operation === "get_active_project"
        ? { guid: "project-1", path: source }
        : { saved: true, projectGuid: "project-1" };
    return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
  }) as typeof fetch;
  let text = "";
  await runCli(
    [
      "project",
      "backup",
      "--output",
      output,
      "--expect-project",
      "project-1",
      "--request-id",
      "request-backup-1",
      "--confirm",
    ],
    (value) => {
      text += value;
    },
    { fetch: fakeFetch },
  );
  assert.deepEqual(requests, [
    { operation: "get_active_project", arguments: {} },
    {
      operation: "save_project",
      arguments: {
        confirm: true,
        expectedProjectGuid: "project-1",
      },
      requestId: "request-backup-1",
    },
  ]);
  assert.equal(await readFile(output, "utf8"), "premiere project");
  assert.equal((JSON.parse(text) as { backedUp?: boolean }).backedUp, true);
});

test("CLI maps media import and project item removal", async (context) => {
  useFixedProtocolToken(context);
  const directory = await mkdtemp(path.join(os.tmpdir(), "premiere-import-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const input = path.join(directory, "audio.wav");
  await writeFile(input, "test audio");
  const requests: Record<string, unknown>[] = [];
  const fakeFetch = (async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ ok: true, result: {} }), {
      status: 200,
    });
  }) as typeof fetch;
  const expectations = [
    "--expect-project",
    "project-1",
    "--expect-sequence",
    "sequence-1",
    "--expect-revision",
    "revision-1",
    "--expect-items-revision",
    "items-1",
    "--confirm",
  ];
  await runCli(
    ["project", "import", "--input", input, ...expectations],
    () => undefined,
    { fetch: fakeFetch },
  );
  await runCli(
    ["project", "item", "remove", "--item-id", "item-1", ...expectations],
    () => undefined,
    { fetch: fakeFetch },
  );
  assert.equal(requests[0]?.operation, "import_media_file");
  assert.deepEqual(requests[0]?.arguments, {
    confirm: true,
    expectedProjectGuid: "project-1",
    expectedSequenceGuid: "sequence-1",
    expectedRevision: "revision-1",
    expectedProjectItemsRevision: "items-1",
    inputFile: await realpath(input),
  });
  assert.equal(requests[1]?.operation, "remove_project_item");
  assert.equal(
    (requests[1]?.arguments as Record<string, unknown>).projectItemId,
    "item-1",
  );
});

test("CLI rejects a mutation without confirmation before network access", async (context) => {
  useFixedProtocolToken(context);
  let called = false;
  const fakeFetch = (async () => {
    called = true;
    return new Response();
  }) as typeof fetch;
  await assert.rejects(
    runCli(
      [
        "timeline",
        "trim",
        "--item-ref",
        "video:0:0",
        "--expect-revision",
        "revision-1",
        "--expect-project",
        "project-1",
        "--expect-sequence",
        "sequence-1",
        "--end-seconds",
        "4",
      ],
      () => undefined,
      { fetch: fakeFetch },
    ),
    /requires --confirm/,
  );
  assert.equal(called, false);
});

test("CLI rejects unknown and duplicate options", async () => {
  await assert.rejects(
    runCli(["project", "--profile", "other"]),
    /Unknown option/,
  );
  await assert.rejects(
    runCli(["project", "--session", "one", "--session", "two"]),
    /Duplicate option/,
  );
});

test("Plugin build uses the fixed plaintext protocol token", async (context) => {
  useFixedProtocolToken(context);
  let captured:
    | { command: string; args: readonly string[]; env?: NodeJS.ProcessEnv }
    | undefined;
  const fakeSpawn = ((
    command: string,
    args: readonly string[] = [],
    options?: { env?: NodeJS.ProcessEnv },
  ) => {
    captured = { command, args, env: options?.env };
    return {
      status: 0,
      stdout: "/repo/plugin/dist/manifest.json\n",
      stderr: "",
    };
  }) as unknown as typeof spawnSync;
  let text = "";
  await runCli(
    ["--port", "2196", "plugin", "build"],
    (value) => {
      text += value;
    },
    { spawn: fakeSpawn },
  );
  assert.equal(captured?.command, "node");
  assert.equal(captured?.args.length, 1);
  assert.equal(captured?.env?.PREMIERE_GATEWAY_PORT, "2196");
  assert.equal(captured?.env?.PREMIERE_GATEWAY_PLUGIN_MODE, "panel");
  assert.equal(
    captured?.env?.PREMIERE_GATEWAY_PLUGIN_DISTRIBUTION,
    "development",
  );
  assert.doesNotMatch(text, /PREMIERE_GATEWAY_SECRET/);
  assert.deepEqual(JSON.parse(text), {
    manifest: "/repo/plugin/dist/manifest.json",
  });
});

test("Plugin build selects Adobe's invisible application-launch mode explicitly", async (context) => {
  useFixedProtocolToken(context);
  let mode: string | undefined;
  const fakeSpawn = ((
    _command: string,
    _args: readonly string[] = [],
    options?: { env?: NodeJS.ProcessEnv },
  ) => {
    void _args;
    mode = options?.env?.PREMIERE_GATEWAY_PLUGIN_MODE;
    return {
      status: 0,
      stdout: "/repo/plugin/dist/manifest.json\n",
      stderr: "",
    };
  }) as unknown as typeof spawnSync;

  await runCli(["plugin", "build", "--mode", "invisible"], () => {}, {
    spawn: fakeSpawn,
  });
  assert.equal(mode, "invisible");

  await assert.rejects(
    runCli(["plugin", "build", "--mode", "background"], () => {}, {
      spawn: fakeSpawn,
    }),
    /--mode must be panel or invisible/,
  );
});

test("Plugin build selects the fixed Marketplace distribution explicitly", async (context) => {
  useFixedProtocolToken(context);
  let distribution: string | undefined;
  const fakeSpawn = ((
    _command: string,
    _args: readonly string[] = [],
    options?: { env?: NodeJS.ProcessEnv },
  ) => {
    void _args;
    distribution = options?.env?.PREMIERE_GATEWAY_PLUGIN_DISTRIBUTION;
    return {
      status: 0,
      stdout: "/repo/plugin/marketplace-dist/manifest.json\n",
      stderr: "",
    };
  }) as unknown as typeof spawnSync;

  await runCli(
    ["plugin", "build", "--mode", "invisible", "--distribution", "marketplace"],
    () => {},
    { spawn: fakeSpawn },
  );
  assert.equal(distribution, "marketplace");

  await assert.rejects(
    runCli(["plugin", "build", "--distribution", "custom"], () => {}, {
      spawn: fakeSpawn,
    }),
    /--distribution must be development or marketplace/,
  );
});

test("managed daemon persists only port and paths", async (context) => {
  const homeDir = await mkdtemp(
    path.join(os.tmpdir(), "premiere-gateway-service-"),
  );
  context.after(() => rm(homeDir, { recursive: true, force: true }));
  let loaded = false;
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const fakeSpawn = ((command: string, args: readonly string[] = []) => {
    calls.push({ command, args });
    if (command === "launchctl" && args[0] === "bootout") {
      loaded = false;
      return { status: 0, stdout: "", stderr: "" };
    }
    if (command === "launchctl" && args[0] === "bootstrap") {
      loaded = true;
      return { status: 0, stdout: "", stderr: "" };
    }
    if (command === "launchctl" && args[0] === "print") {
      return loaded
        ? { status: 0, stdout: "state = running\npid = 12345\n", stderr: "" }
        : { status: 113, stdout: "", stderr: "not loaded" };
    }
    return { status: 0, stdout: "", stderr: "" };
  }) as unknown as typeof spawnSync;
  let text = "";
  await runCli(
    ["--port", "2196", "daemon", "install"],
    (value) => {
      text += value;
    },
    {
      daemonService: {
        spawn: fakeSpawn,
        homeDir,
        uid: 501,
        platform: "darwin",
        nodePath: "/opt/node/bin/node",
        entrypoint: "/opt/premiere-gateway/dist/cli/index.js",
        pathValue: "/opt/node/bin:/usr/bin:/bin",
      },
    },
  );
  const result = JSON.parse(text) as Record<string, unknown>;
  assert.equal(result.installed, true);
  assert.equal(result.loaded, true);
  assert.equal(result.port, 2196);
  assert.equal(result.service, DAEMON_SERVICE_LABEL);
  const plist = await readFile(
    path.join(
      homeDir,
      "Library",
      "LaunchAgents",
      `${DAEMON_SERVICE_LABEL}.plist`,
    ),
    "utf8",
  );
  assert.match(plist, /PREMIERE_GATEWAY_PORT/);
  assert.match(plist, /<string>2196<\/string>/);
  assert.doesNotMatch(plist, /PREMIERE_GATEWAY_SECRET/);
  assert.ok(calls.some((call) => call.command === "plutil"));
  assert.ok(
    calls.some(
      (call) => call.command === "launchctl" && call.args[0] === "kickstart",
    ),
  );

  text = "";
  await runCli(
    ["--port", "2999", "daemon", "status"],
    (value) => {
      text += value;
    },
    {
      daemonService: {
        spawn: fakeSpawn,
        homeDir,
        uid: 501,
        platform: "darwin",
      },
    },
  );
  const statusFromDifferentCaller = JSON.parse(text) as Record<string, unknown>;
  assert.equal(statusFromDifferentCaller.port, 2196);
});

test("managed daemon uninstall requires explicit confirmation", async () => {
  await assert.rejects(
    runCli(["daemon", "uninstall"], () => undefined, {
      daemonService: { platform: "darwin", homeDir: "/tmp", uid: 501 },
    }),
    /requires --confirm/,
  );
});

test("managed daemon rejects confirmation on non-destructive actions", async () => {
  await assert.rejects(
    runCli(["daemon", "status", "--confirm"], () => undefined, {
      daemonService: { platform: "darwin", homeDir: "/tmp", uid: 501 },
    }),
    /Unknown daemon option/,
  );
});
