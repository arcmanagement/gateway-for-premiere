import { spawn as spawnProcess, spawnSync } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import {
  access,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveApprovalMode } from "./config.js";
import type { ApprovalMode } from "../shared/protocol.js";

export const DAEMON_SERVICE_LABEL = "com.arcmanagement.gateway-for-premiere";

type Writer = (value: string) => void;
type Spawn = typeof spawnSync;

export interface DaemonServiceDependencies {
  spawn?: Spawn;
  homeDir?: string;
  uid?: number;
  platform?: NodeJS.Platform;
  nodePath?: string;
  entrypoint?: string;
  pathValue?: string;
  waitDelays?: number[];
  localAppData?: string;
  windowsUser?: string;
  windowsUserDomain?: string;
  processRunning?: (pid: number) => boolean;
  spawnDetached?: typeof spawnProcess;
}

interface LaunchAgentConfig {
  nodePath: string;
  entrypoint: string;
  logPath: string;
  pathValue: string;
  port: number;
  approvalMode: ApprovalMode;
}

function daemonOptions(
  action: string,
  trailing: string[],
): { confirm: boolean; approvalMode?: ApprovalMode } {
  if (action === "approval-mode") {
    if (trailing.length !== 1) {
      throw new Error(
        "daemon approval-mode requires exactly one of: ask, auto, bypass",
      );
    }
    return { confirm: false, approvalMode: resolveApprovalMode(trailing[0]) };
  }
  let confirm = false;
  let approvalMode: ApprovalMode | undefined;
  for (let index = 0; index < trailing.length; index += 1) {
    const option = trailing[index]!;
    if (option === "--confirm" && action === "uninstall") {
      confirm = true;
      continue;
    }
    if (option === "--approval-mode" && action === "install") {
      const value = trailing[index + 1];
      if (!value) throw new Error("--approval-mode requires a value");
      approvalMode = resolveApprovalMode(value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown daemon option: ${option}`);
  }
  return { confirm, ...(approvalMode ? { approvalMode } : {}) };
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function unxml(value: string): string {
  return value
    .replaceAll("&apos;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}

export function buildLaunchAgentPlist(config: LaunchAgentConfig): string {
  const args = [config.nodePath, config.entrypoint, "daemon"];
  const strings = args.map((value) => `    <string>${xml(value)}</string>`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${DAEMON_SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${strings.join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(config.pathValue)}</string>
    <key>GATEWAY_FOR_PREMIERE_PORT</key>
    <string>${config.port}</string>
    <key>GATEWAY_FOR_PREMIERE_APPROVAL_MODE</key>
    <string>${config.approvalMode}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xml(config.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(config.logPath)}</string>
</dict>
</plist>
`;
}

function resultText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function run(
  spawn: Spawn,
  command: string,
  args: string[],
  allowFailure = false,
): ReturnType<Spawn> {
  const result = spawn(command, args, { encoding: "utf8" });
  if (!allowFailure && (result.error || result.status !== 0)) {
    const detail =
      resultText(result.stderr) ||
      resultText(result.stdout) ||
      result.error?.message ||
      "unknown error";
    throw new Error(`${command} ${args.join(" ")} failed: ${detail}`);
  }
  return result;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function installedPort(plistPath: string): Promise<number | null> {
  if (!(await exists(plistPath))) return null;
  const source = await readFile(plistPath, "utf8");
  const match = source.match(
    /<key>GATEWAY_FOR_PREMIERE_PORT<\/key>\s*<string>([^<]+)<\/string>/,
  );
  const port = Number(match ? unxml(match[1]!) : "");
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

async function installedApprovalMode(
  plistPath: string,
): Promise<ApprovalMode | null> {
  if (!(await exists(plistPath))) return null;
  const source = await readFile(plistPath, "utf8");
  const match = source.match(
    /<key>GATEWAY_FOR_PREMIERE_APPROVAL_MODE<\/key>\s*<string>([^<]+)<\/string>/,
  );
  return match ? resolveApprovalMode(unxml(match[1]!)) : "ask";
}

async function installedLaunchAgentValue(
  plistPath: string,
  key: "nodePath" | "entrypoint" | "pathValue",
): Promise<string | null> {
  if (!(await exists(plistPath))) return null;
  const source = await readFile(plistPath, "utf8");
  if (key === "pathValue") {
    const match = source.match(/<key>PATH<\/key>\s*<string>([^<]+)<\/string>/);
    return match ? unxml(match[1]!) : null;
  }
  const argumentsBlock = source.match(
    /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/,
  )?.[1];
  if (!argumentsBlock) return null;
  const values = [...argumentsBlock.matchAll(/<string>([^<]+)<\/string>/g)].map(
    (match) => unxml(match[1]!),
  );
  return values[key === "nodePath" ? 0 : 1] || null;
}

function statusValue(
  spawn: Spawn,
  target: string,
): { loaded: boolean; state: string | null; pid: number | null } {
  const result = run(spawn, "launchctl", ["print", target], true);
  const value = resultText(result.stdout);
  const state = value.match(/^\s*state = (\S+)/m)?.[1] || null;
  const pidValue = value.match(/^\s*pid = (\d+)/m)?.[1];
  return {
    loaded: result.status === 0,
    state,
    pid: pidValue ? Number(pidValue) : null,
  };
}

async function waitFor(
  spawn: Spawn,
  target: string,
  expectedLoaded: boolean,
  delays: number[],
): Promise<void> {
  let status = statusValue(spawn, target);
  for (const delay of delays) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    status = statusValue(spawn, target);
    const running =
      status.loaded && status.state === "running" && status.pid !== null;
    if (expectedLoaded ? running : !status.loaded) return;
  }
  throw new Error(
    expectedLoaded
      ? `Daemon did not reach the running state (state: ${status.state || "not loaded"})`
      : `Daemon did not stop (state: ${status.state || "unknown"})`,
  );
}

async function bootstrap(
  spawn: Spawn,
  domain: string,
  plistPath: string,
): Promise<void> {
  let result: ReturnType<Spawn> | undefined;
  for (const delay of [0, 100, 250, 500, 1_000]) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    result = run(spawn, "launchctl", ["bootstrap", domain, plistPath], true);
    if (!result.error && result.status === 0) return;
  }
  const detail =
    resultText(result?.stderr) ||
    resultText(result?.stdout) ||
    result?.error?.message ||
    "unknown error";
  throw new Error(`launchctl bootstrap failed: ${detail}`);
}

async function runDarwinDaemonService(
  port: number,
  argv: string[],
  writer: Writer,
  dependencies: DaemonServiceDependencies = {},
): Promise<void> {
  const action = argv[0] || "status";
  const allowed = new Set([
    "install",
    "start",
    "stop",
    "restart",
    "status",
    "approval-mode",
    "uninstall",
  ]);
  if (!allowed.has(action))
    throw new Error(`Unknown daemon command: ${action}`);
  const { confirm, approvalMode } = daemonOptions(action, argv.slice(1));

  const spawn = dependencies.spawn || spawnSync;
  const homeDir = dependencies.homeDir || os.homedir();
  const uid = dependencies.uid ?? process.getuid?.();
  if (uid === undefined) throw new Error("Could not determine current user ID");
  const launchAgentsDir = path.join(homeDir, "Library", "LaunchAgents");
  const logsDir = path.join(homeDir, "Library", "Logs");
  const plistPath = path.join(launchAgentsDir, `${DAEMON_SERVICE_LABEL}.plist`);
  const logPath = path.join(logsDir, "gateway-for-premiere.log");
  const domain = `gui/${uid}`;
  const target = `${domain}/${DAEMON_SERVICE_LABEL}`;
  const delays = dependencies.waitDelays || [0, 50, 100, 250, 500, 1_000];

  const serviceStatus = async (): Promise<Record<string, unknown>> => {
    const installed = await exists(plistPath);
    return {
      ok: true,
      service: DAEMON_SERVICE_LABEL,
      plist: plistPath,
      log: logPath,
      installed,
      autostart: installed ? "launch-agent" : null,
      autostartRegistered: installed,
      port: installed ? await installedPort(plistPath) : null,
      approvalMode: installed ? await installedApprovalMode(plistPath) : null,
      ...statusValue(spawn, target),
    };
  };

  if (action === "status") {
    writer(`${JSON.stringify(await serviceStatus(), null, 2)}\n`);
    return;
  }

  if (action === "install" || action === "approval-mode") {
    if (action === "approval-mode" && !(await exists(plistPath))) {
      throw new Error(
        "Daemon is not installed; run `gateway-for-premiere daemon install --approval-mode MODE`",
      );
    }
    await mkdir(launchAgentsDir, { recursive: true });
    await mkdir(logsDir, { recursive: true });
    const nodePath =
      (action === "approval-mode"
        ? await installedLaunchAgentValue(plistPath, "nodePath")
        : null) ||
      dependencies.nodePath ||
      process.execPath;
    const entrypoint =
      (action === "approval-mode"
        ? await installedLaunchAgentValue(plistPath, "entrypoint")
        : null) ||
      dependencies.entrypoint ||
      process.argv[1];
    if (!entrypoint)
      throw new Error("Could not determine gateway-for-premiere entrypoint");
    const pathValue =
      (action === "approval-mode"
        ? await installedLaunchAgentValue(plistPath, "pathValue")
        : null) ||
      dependencies.pathValue ||
      [
        ...new Set([
          path.dirname(nodePath),
          "/opt/homebrew/bin",
          "/usr/local/bin",
          "/usr/bin",
          "/bin",
          "/usr/sbin",
          "/sbin",
        ]),
      ].join(":");
    const temporaryPath = `${plistPath}.${process.pid}.tmp`;
    await writeFile(
      temporaryPath,
      buildLaunchAgentPlist({
        nodePath,
        entrypoint,
        logPath,
        pathValue,
        port:
          action === "approval-mode"
            ? (await installedPort(plistPath)) || port
            : port,
        approvalMode: approvalMode || resolveApprovalMode(),
      }),
      { encoding: "utf8", mode: 0o644 },
    );
    run(spawn, "plutil", ["-lint", temporaryPath]);
    await rename(temporaryPath, plistPath);
    run(spawn, "launchctl", ["bootout", target], true);
    await waitFor(spawn, target, false, delays);
    await bootstrap(spawn, domain, plistPath);
    run(spawn, "launchctl", ["enable", target]);
    run(spawn, "launchctl", ["kickstart", "-k", target]);
    await waitFor(spawn, target, true, delays);
    writer(`${JSON.stringify(await serviceStatus(), null, 2)}\n`);
    return;
  }

  if (action === "uninstall") {
    if (!confirm) throw new Error("daemon uninstall requires --confirm");
    run(spawn, "launchctl", ["bootout", target], true);
    await waitFor(spawn, target, false, delays);
    await rm(plistPath, { force: true });
    writer(`${JSON.stringify(await serviceStatus(), null, 2)}\n`);
    return;
  }

  if (!(await exists(plistPath))) {
    throw new Error(
      "Daemon is not installed; run `gateway-for-premiere daemon install`",
    );
  }
  if (action === "stop" || action === "restart") {
    run(spawn, "launchctl", ["bootout", target], true);
    await waitFor(spawn, target, false, delays);
  }
  if (action === "start" || action === "restart") {
    await bootstrap(spawn, domain, plistPath);
    run(spawn, "launchctl", ["kickstart", "-k", target]);
    await waitFor(spawn, target, true, delays);
  }
  writer(`${JSON.stringify(await serviceStatus(), null, 2)}\n`);
}

export const WINDOWS_DAEMON_TASK = "ArcManagement Gateway for Premiere";
export const WINDOWS_RUN_KEY =
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
export const WINDOWS_RUN_VALUE = WINDOWS_DAEMON_TASK;

export type WindowsAutostart = "scheduled-task" | "startup-registry" | null;

interface WindowsDaemonConfig {
  nodePath: string;
  entrypoint: string;
  logPath: string;
  pidPath: string;
  port: number;
  approvalMode?: ApprovalMode;
}

function windowsVbsValue(value: string): string {
  return value.replaceAll('"', '""');
}

function buildWindowsHiddenLauncher(launcherPath: string): string {
  return [
    "' Starts the Gateway for Premiere broker without a console window.",
    'Set shell = CreateObject("WScript.Shell")',
    `shell.Run """${windowsVbsValue(launcherPath)}""", 0, False`,
    "",
  ].join("\r\n");
}

function failureDetail(result: ReturnType<Spawn>): string {
  const detail =
    resultText(result.stderr) ||
    resultText(result.stdout) ||
    result.error?.message ||
    "";
  // Windows console tools answer in the OS code page, which Node decodes as
  // UTF-8 and turns into unreadable text on a localized machine. Report such a
  // message by its exit code rather than printing the mangled bytes.
  const readable = detail.replaceAll(/\s+/g, " ").trim();
  const exitCode =
    typeof result.status === "number"
      ? `exit code ${result.status}`
      : "unknown error";
  if (!readable) return exitCode;
  // eslint-disable-next-line no-control-regex
  return /[^\x09\x0a\x0d\x20-\x7e]/.test(readable) ? exitCode : readable;
}

function windowsCommandValue(value: string): string {
  return value.replaceAll("%", "%%");
}

function windowsProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function windowsPid(
  pidPath: string,
  processRunning: (pid: number) => boolean,
): Promise<number | null> {
  try {
    const pid = Number((await readFile(pidPath, "utf8")).trim());
    return Number.isInteger(pid) && pid > 0 && processRunning(pid) ? pid : null;
  } catch {
    return null;
  }
}

async function waitForWindows(
  pidPath: string,
  expectedRunning: boolean,
  processRunning: (pid: number) => boolean,
  delays: number[],
): Promise<void> {
  let pid = await windowsPid(pidPath, processRunning);
  for (const delay of delays) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    pid = await windowsPid(pidPath, processRunning);
    if (expectedRunning ? pid !== null : pid === null) return;
  }
  throw new Error(
    expectedRunning
      ? "Daemon did not reach the running state"
      : `Daemon did not stop (pid: ${pid ?? "unknown"})`,
  );
}

async function runWindowsDaemonService(
  port: number,
  argv: string[],
  writer: Writer,
  dependencies: DaemonServiceDependencies,
): Promise<void> {
  const action = argv[0] || "status";
  const allowed = new Set([
    "install",
    "start",
    "stop",
    "restart",
    "status",
    "approval-mode",
    "uninstall",
  ]);
  if (!allowed.has(action))
    throw new Error(`Unknown daemon command: ${action}`);
  const { confirm, approvalMode } = daemonOptions(action, argv.slice(1));

  const spawn = dependencies.spawn || spawnSync;
  const localAppData =
    dependencies.localAppData || process.env.LOCALAPPDATA || os.homedir();
  const serviceDir = path.join(localAppData, "Gateway for Premiere");
  const configPath = path.join(serviceDir, "daemon.json");
  const launcherPath = path.join(serviceDir, "daemon.cmd");
  const hiddenLauncherPath = path.join(serviceDir, "daemon.vbs");
  const userName = dependencies.windowsUser || process.env.USERNAME || "";
  const userDomain =
    dependencies.windowsUserDomain || process.env.USERDOMAIN || "";
  const windowsUser = userName
    ? userDomain
      ? `${userDomain}\\${userName}`
      : userName
    : "";
  const logPath = path.join(serviceDir, "gateway-for-premiere.log");
  const pidPath = path.join(serviceDir, "gateway-for-premiere.pid");
  const delays = dependencies.waitDelays || [0, 100, 250, 500, 1_000, 2_000];
  const processRunning = dependencies.processRunning || windowsProcessRunning;
  const spawnDetached = dependencies.spawnDetached || spawnProcess;

  const readConfig = async (): Promise<WindowsDaemonConfig | null> => {
    try {
      return JSON.parse(
        await readFile(configPath, "utf8"),
      ) as WindowsDaemonConfig;
    } catch {
      return null;
    }
  };
  const taskExists = (): boolean => {
    const result = run(
      spawn,
      "schtasks.exe",
      ["/Query", "/TN", WINDOWS_DAEMON_TASK],
      true,
    );
    return !result.error && result.status === 0;
  };
  const runEntryExists = (): boolean => {
    const result = run(
      spawn,
      "reg.exe",
      ["query", WINDOWS_RUN_KEY, "/v", WINDOWS_RUN_VALUE],
      true,
    );
    return !result.error && result.status === 0;
  };
  const autostartMethod = (): WindowsAutostart => {
    if (taskExists()) return "scheduled-task";
    if (runEntryExists()) return "startup-registry";
    return null;
  };
  const serviceStatus = async (
    warnings: string[] = [],
    registered?: WindowsAutostart,
  ): Promise<Record<string, unknown>> => {
    const config = await readConfig();
    const pid = await windowsPid(config?.pidPath || pidPath, processRunning);
    const installed = config !== null;
    const autostart =
      registered !== undefined
        ? registered
        : installed
          ? autostartMethod()
          : null;
    return {
      ok: true,
      service: WINDOWS_DAEMON_TASK,
      config: configPath,
      log: config?.logPath || logPath,
      installed,
      autostart,
      autostartRegistered: autostart !== null,
      port: config?.port ?? null,
      approvalMode: config ? config.approvalMode || "ask" : null,
      loaded: pid !== null,
      state: pid !== null ? "running" : installed ? "stopped" : null,
      pid,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  };
  const startDetached = (config: WindowsDaemonConfig): void => {
    const log = openSync(config.logPath, "a");
    try {
      const child = spawnDetached(
        config.nodePath,
        [config.entrypoint, "daemon"],
        {
          detached: true,
          windowsHide: true,
          stdio: ["ignore", log, log],
          env: {
            ...process.env,
            GATEWAY_FOR_PREMIERE_PORT: String(config.port),
            GATEWAY_FOR_PREMIERE_PID_FILE: config.pidPath,
            GATEWAY_FOR_PREMIERE_APPROVAL_MODE: config.approvalMode || "ask",
          },
        },
      );
      child.unref();
    } finally {
      closeSync(log);
    }
  };

  if (action === "status") {
    writer(`${JSON.stringify(await serviceStatus(), null, 2)}\n`);
    return;
  }
  if (action === "uninstall" && !confirm) {
    throw new Error("daemon uninstall requires --confirm");
  }

  if (action === "install" || action === "approval-mode") {
    const previousConfig = await readConfig();
    if (action === "approval-mode" && !previousConfig) {
      throw new Error(
        "Daemon is not installed; run `gateway-for-premiere daemon install --approval-mode MODE`",
      );
    }
    const previousPid = await windowsPid(
      previousConfig?.pidPath || pidPath,
      processRunning,
    );
    if (previousPid !== null) {
      run(
        spawn,
        "taskkill.exe",
        ["/PID", String(previousPid), "/T", "/F"],
        true,
      );
      await waitForWindows(
        previousConfig?.pidPath || pidPath,
        false,
        processRunning,
        delays,
      );
    }
    const nodePath =
      previousConfig?.nodePath || dependencies.nodePath || process.execPath;
    const entrypoint =
      previousConfig?.entrypoint || dependencies.entrypoint || process.argv[1];
    if (!entrypoint)
      throw new Error("Could not determine gateway-for-premiere entrypoint");
    await mkdir(serviceDir, { recursive: true });
    const config: WindowsDaemonConfig = {
      nodePath,
      entrypoint,
      logPath,
      pidPath,
      port: action === "approval-mode" ? previousConfig?.port || port : port,
      approvalMode: approvalMode || resolveApprovalMode(),
    };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    const launcher = [
      "@echo off",
      `set "GATEWAY_FOR_PREMIERE_PORT=${config.port}"`,
      `set "GATEWAY_FOR_PREMIERE_PID_FILE=${windowsCommandValue(pidPath)}"`,
      `set "GATEWAY_FOR_PREMIERE_APPROVAL_MODE=${config.approvalMode}"`,
      `"${windowsCommandValue(nodePath)}" "${windowsCommandValue(entrypoint)}" daemon >> "${windowsCommandValue(logPath)}" 2>&1`,
      "",
    ].join("\r\n");
    await writeFile(launcherPath, launcher, "utf8");
    await writeFile(
      hiddenLauncherPath,
      buildWindowsHiddenLauncher(launcherPath),
      "utf8",
    );
    // Sign-in autostart must work on an account without administrator rights.
    // Task Scheduler is tried first as the account's own interactive task, then
    // as a plain task, then the per-user Run key. Installation still succeeds
    // when every one of them is refused.
    const warnings: string[] = [];
    const trigger = `cmd.exe /d /s /c ""${launcherPath}""`;
    const taskAttempts: string[][] = [];
    if (windowsUser) {
      taskAttempts.push([
        "/Create",
        "/TN",
        WINDOWS_DAEMON_TASK,
        "/SC",
        "ONLOGON",
        "/TR",
        trigger,
        "/RU",
        windowsUser,
        "/IT",
        "/RL",
        "LIMITED",
        "/F",
      ]);
    }
    taskAttempts.push([
      "/Create",
      "/TN",
      WINDOWS_DAEMON_TASK,
      "/SC",
      "ONLOGON",
      "/TR",
      trigger,
      "/F",
    ]);
    let taskRegistered = false;
    let lastTaskFailure = "";
    for (const attempt of taskAttempts) {
      const result = run(spawn, "schtasks.exe", attempt, true);
      if (!result.error && result.status === 0) {
        taskRegistered = true;
        break;
      }
      lastTaskFailure = failureDetail(result);
    }
    let registered: WindowsAutostart = null;
    if (taskRegistered) {
      registered = "scheduled-task";
      if (runEntryExists()) {
        run(
          spawn,
          "reg.exe",
          ["delete", WINDOWS_RUN_KEY, "/v", WINDOWS_RUN_VALUE, "/f"],
          true,
        );
      }
    } else {
      warnings.push(
        `Could not register the sign-in scheduled task: ${lastTaskFailure}`,
      );
      if (taskExists()) {
        warnings.push(
          `A scheduled task named "${WINDOWS_DAEMON_TASK}" already exists and could not be updated. It may still start an earlier installation at sign-in.`,
        );
      }
      const registryResult = run(
        spawn,
        "reg.exe",
        [
          "add",
          WINDOWS_RUN_KEY,
          "/v",
          WINDOWS_RUN_VALUE,
          "/t",
          "REG_SZ",
          "/d",
          `wscript.exe "${hiddenLauncherPath}"`,
          "/f",
        ],
        true,
      );
      if (registryResult.error || registryResult.status !== 0) {
        warnings.push(
          `Could not register the sign-in Run entry: ${failureDetail(registryResult)}`,
        );
        warnings.push(
          "The broker is running now, but it will not start again automatically. Run `gateway-for-premiere daemon start` after each sign-in.",
        );
      } else {
        registered = "startup-registry";
        warnings.push(
          `Registered sign-in autostart under ${WINDOWS_RUN_KEY} instead.`,
        );
      }
    }
    startDetached(config);
    await waitForWindows(pidPath, true, processRunning, delays);
    writer(
      `${JSON.stringify(await serviceStatus(warnings, registered), null, 2)}\n`,
    );
    return;
  }

  const config = await readConfig();
  if (!config) {
    throw new Error(
      "Daemon is not installed; run `gateway-for-premiere daemon install`",
    );
  }
  if (action === "stop" || action === "restart" || action === "uninstall") {
    const pid = await windowsPid(config.pidPath, processRunning);
    if (pid !== null) {
      run(spawn, "taskkill.exe", ["/PID", String(pid), "/T", "/F"], true);
    }
    run(spawn, "schtasks.exe", ["/End", "/TN", WINDOWS_DAEMON_TASK], true);
    await waitForWindows(config.pidPath, false, processRunning, delays);
  }
  if (action === "uninstall") {
    const warnings: string[] = [];
    if (taskExists()) {
      const result = run(
        spawn,
        "schtasks.exe",
        ["/Delete", "/TN", WINDOWS_DAEMON_TASK, "/F"],
        true,
      );
      if (result.error || result.status !== 0) {
        warnings.push(
          `Could not remove the scheduled task: ${failureDetail(result)}`,
        );
      }
    }
    if (runEntryExists()) {
      const result = run(
        spawn,
        "reg.exe",
        ["delete", WINDOWS_RUN_KEY, "/v", WINDOWS_RUN_VALUE, "/f"],
        true,
      );
      if (result.error || result.status !== 0) {
        warnings.push(
          `Could not remove the sign-in Run entry: ${failureDetail(result)}`,
        );
      }
    }
    await rm(serviceDir, { recursive: true, force: true });
    writer(`${JSON.stringify(await serviceStatus(warnings), null, 2)}\n`);
    return;
  }
  if (action === "start" || action === "restart") {
    startDetached(config);
    await waitForWindows(config.pidPath, true, processRunning, delays);
  }
  writer(`${JSON.stringify(await serviceStatus(), null, 2)}\n`);
}

export async function runDaemonService(
  port: number,
  argv: string[],
  writer: Writer,
  dependencies: DaemonServiceDependencies = {},
): Promise<void> {
  const platform = dependencies.platform || process.platform;
  if (platform === "darwin") {
    return runDarwinDaemonService(port, argv, writer, dependencies);
  }
  if (platform === "win32") {
    return runWindowsDaemonService(port, argv, writer, dependencies);
  }
  throw new Error(
    "Managed daemon commands are supported on macOS and Windows only",
  );
}
