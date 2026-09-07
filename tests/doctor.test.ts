import assert from "node:assert/strict";
import test from "node:test";
import { buildDoctorReport } from "../src/cli/doctor.js";

test("doctor separates a live development session from persistent readiness", () => {
  const report = buildDoctorReport({
    port: 1966,
    daemon: {
      installed: false,
      loaded: false,
      state: null,
      pid: null,
      port: null,
    },
    health: {
      ok: true,
      sessions: [
        {
          sessionId: "session-1",
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
    },
  }) as {
    ok: boolean;
    access: { mode: string; token: string; loopbackOnly: boolean };
    readiness: {
      liveSession: boolean;
      editableSession: boolean;
      persistentBroker: boolean;
    };
    nextActions: string[];
  };

  assert.equal(report.ok, true);
  assert.deepEqual(report.access, {
    mode: "fixed-public-protocol-token",
    token: "gateway-for-premiere",
    loopbackOnly: true,
  });
  assert.deepEqual(report.readiness, {
    liveSession: true,
    editableSession: true,
    persistentBrokerConfigured: false,
    persistentBroker: false,
    coldStartPlugin:
      "live Plugin session connected; cold-start provenance requires restart observation",
  });
  assert.deepEqual(report.nextActions, ["gateway-for-premiere daemon install"]);
});

test("doctor reports a persistently configured broker separately from CCX cold start", () => {
  const report = buildDoctorReport({
    port: 1966,
    daemon: {
      installed: true,
      loaded: true,
      state: "running",
      pid: 123,
      port: 1966,
    },
    health: {
      ok: true,
      sessions: [
        {
          sessionId: "session-1",
          premiereVersion: "27.0.0",
          journalStatus: "ready",
        },
      ],
    },
  }) as {
    ok: boolean;
    readiness: {
      liveSession: boolean;
      editableSession: boolean;
      persistentBroker: boolean;
    };
    nextActions: string[];
  };

  assert.equal(report.ok, false);
  assert.equal(report.readiness.liveSession, true);
  assert.equal(report.readiness.editableSession, false);
  assert.equal(report.readiness.persistentBroker, true);
  assert.deepEqual(report.nextActions, [
    "Open a compatible Premiere project and active sequence",
  ]);
});

test("doctor requests a daemon restart when the configured broker is unreachable", () => {
  const report = buildDoctorReport({
    port: 1966,
    daemon: {
      installed: true,
      loaded: true,
      state: "running",
      pid: 123,
      port: 1966,
    },
    brokerError: "connection refused",
  }) as {
    readiness: {
      liveSession: boolean;
      editableSession: boolean;
      persistentBrokerConfigured: boolean;
      persistentBroker: boolean;
    };
    nextActions: string[];
  };

  assert.equal(report.readiness.liveSession, false);
  assert.equal(report.readiness.editableSession, false);
  assert.equal(report.readiness.persistentBrokerConfigured, true);
  assert.equal(report.readiness.persistentBroker, false);
  assert.deepEqual(report.nextActions, [
    "gateway-for-premiere daemon restart",
    "Open a compatible Premiere project and connect the Gateway for Premiere Plugin",
  ]);
});

test("doctor does not accept unsupported Premiere or an unready journal", () => {
  const report = buildDoctorReport({
    port: 1966,
    daemon: {
      installed: true,
      loaded: true,
      state: "running",
      pid: 123,
      port: 1966,
    },
    health: {
      ok: true,
      sessions: [
        {
          sessionId: "session-old",
          premiereVersion: "26.2.9",
          journalStatus: "ready",
        },
        {
          sessionId: "session-journal",
          premiereVersion: "26.3.0",
          journalStatus: "failed",
        },
      ],
    },
  }) as {
    ok: boolean;
    sessions: Array<{
      supportedPremiere: boolean;
      journalReady: boolean;
    }>;
    nextActions: string[];
  };

  assert.equal(report.ok, false);
  assert.deepEqual(
    report.sessions.map((session) => ({
      supportedPremiere: session.supportedPremiere,
      journalReady: session.journalReady,
    })),
    [
      { supportedPremiere: false, journalReady: true },
      { supportedPremiere: true, journalReady: false },
    ],
  );
  assert.match(report.nextActions[0] || "", /compatible Premiere project/);
});
