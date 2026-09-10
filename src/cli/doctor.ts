export interface DoctorDaemonStatus {
  installed?: unknown;
  port?: unknown;
  loaded?: unknown;
  state?: unknown;
  pid?: unknown;
  approvalMode?: unknown;
}

export interface DoctorHealthSession {
  sessionId?: unknown;
  pluginVersion?: unknown;
  premiereVersion?: unknown;
  journalStatus?: unknown;
  journalEntries?: unknown;
  projectGuid?: unknown;
  projectName?: unknown;
  sequenceGuid?: unknown;
  sequenceName?: unknown;
}

export interface DoctorHealth {
  ok?: unknown;
  sessions?: unknown;
  approvalMode?: unknown;
}

export interface DoctorInput {
  port: number;
  daemon: DoctorDaemonStatus;
  health?: DoctorHealth;
  brokerError?: string;
}

function supportedPremiereVersion(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const match = value.match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 26 || (major === 26 && minor >= 3);
}

export function buildDoctorReport(input: DoctorInput): Record<string, unknown> {
  const sessions = Array.isArray(input.health?.sessions)
    ? (input.health.sessions as DoctorHealthSession[])
    : [];
  const sessionChecks = sessions.map((session) => ({
    sessionId: typeof session.sessionId === "string" ? session.sessionId : null,
    pluginVersion:
      typeof session.pluginVersion === "string" ? session.pluginVersion : null,
    premiereVersion:
      typeof session.premiereVersion === "string"
        ? session.premiereVersion
        : null,
    supportedPremiere: supportedPremiereVersion(session.premiereVersion),
    journalReady: session.journalStatus === "ready",
    journalEntries:
      typeof session.journalEntries === "number"
        ? session.journalEntries
        : null,
    project: {
      guid:
        typeof session.projectGuid === "string" ? session.projectGuid : null,
      name:
        typeof session.projectName === "string" ? session.projectName : null,
    },
    sequence: {
      guid:
        typeof session.sequenceGuid === "string" ? session.sequenceGuid : null,
      name:
        typeof session.sequenceName === "string" ? session.sequenceName : null,
    },
  }));
  const brokerReachable = input.health?.ok === true;
  const liveSession =
    brokerReachable &&
    sessionChecks.some(
      (session) => session.supportedPremiere && session.journalReady,
    );
  const editableSession =
    brokerReachable &&
    sessionChecks.some(
      (session) =>
        session.supportedPremiere &&
        session.journalReady &&
        session.project.guid !== null &&
        session.sequence.guid !== null,
    );
  const daemonPort =
    typeof input.daemon.port === "number" ? input.daemon.port : null;
  const persistentBrokerConfigured =
    input.daemon.installed === true &&
    input.daemon.loaded === true &&
    input.daemon.state === "running" &&
    daemonPort === input.port;
  const daemonApprovalMode =
    typeof input.daemon.approvalMode === "string"
      ? input.daemon.approvalMode
      : null;
  const brokerApprovalMode =
    typeof input.health?.approvalMode === "string"
      ? input.health.approvalMode
      : null;
  const approvalModesMatch =
    daemonApprovalMode !== null &&
    brokerApprovalMode !== null &&
    daemonApprovalMode === brokerApprovalMode;
  const persistentBroker =
    persistentBrokerConfigured && brokerReachable && approvalModesMatch;

  const nextActions: string[] = [];
  if (input.daemon.installed !== true)
    nextActions.push("gateway-for-premiere daemon install");
  else if (!persistentBroker)
    nextActions.push("gateway-for-premiere daemon restart");
  if (!liveSession)
    nextActions.push(
      "Open a compatible Premiere project and connect the Gateway for Premiere Plugin",
    );
  else if (!editableSession)
    nextActions.push("Open a compatible Premiere project and active sequence");

  return {
    ok: editableSession,
    port: input.port,
    access: {
      mode: "fixed-public-protocol-token",
      token: "gateway-for-premiere",
      loopbackOnly: true,
    },
    daemon: {
      installed: input.daemon.installed === true,
      loaded: input.daemon.loaded === true,
      state: typeof input.daemon.state === "string" ? input.daemon.state : null,
      pid: typeof input.daemon.pid === "number" ? input.daemon.pid : null,
      port: daemonPort,
      portMatches: daemonPort === input.port,
      approvalMode: daemonApprovalMode,
    },
    broker: {
      reachable: brokerReachable,
      tokenAccepted: brokerReachable,
      approvalMode: brokerApprovalMode,
      ...(input.brokerError ? { error: input.brokerError } : {}),
    },
    sessions: sessionChecks,
    readiness: {
      liveSession,
      editableSession,
      persistentBrokerConfigured,
      persistentBroker,
      approvalModesMatch,
      coldStartPlugin: liveSession
        ? "live Plugin session connected; cold-start provenance requires restart observation"
        : "install the CCX, restart Premiere, and wait for the Plugin session",
    },
    nextActions,
  };
}
