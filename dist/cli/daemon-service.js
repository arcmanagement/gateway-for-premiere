import { spawn as spawnProcess, spawnSync } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { access, mkdir, readFile, rename, rm, writeFile, } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
export const DAEMON_SERVICE_LABEL = "com.arcmanagement.gateway-for-premiere";
function xml(value) {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&apos;");
}
function unxml(value) {
    return value
        .replaceAll("&apos;", "'")
        .replaceAll("&quot;", '"')
        .replaceAll("&gt;", ">")
        .replaceAll("&lt;", "<")
        .replaceAll("&amp;", "&");
}
export function buildLaunchAgentPlist(config) {
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
function resultText(value) {
    return typeof value === "string" ? value.trim() : "";
}
function run(spawn, command, args, allowFailure = false) {
    const result = spawn(command, args, { encoding: "utf8" });
    if (!allowFailure && (result.error || result.status !== 0)) {
        const detail = resultText(result.stderr) ||
            resultText(result.stdout) ||
            result.error?.message ||
            "unknown error";
        throw new Error(`${command} ${args.join(" ")} failed: ${detail}`);
    }
    return result;
}
async function exists(filePath) {
    try {
        await access(filePath);
        return true;
    }
    catch {
        return false;
    }
}
async function installedPort(plistPath) {
    if (!(await exists(plistPath)))
        return null;
    const source = await readFile(plistPath, "utf8");
    const match = source.match(/<key>GATEWAY_FOR_PREMIERE_PORT<\/key>\s*<string>([^<]+)<\/string>/);
    const port = Number(match ? unxml(match[1]) : "");
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}
function statusValue(spawn, target) {
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
async function waitFor(spawn, target, expectedLoaded, delays) {
    let status = statusValue(spawn, target);
    for (const delay of delays) {
        if (delay)
            await new Promise((resolve) => setTimeout(resolve, delay));
        status = statusValue(spawn, target);
        const running = status.loaded && status.state === "running" && status.pid !== null;
        if (expectedLoaded ? running : !status.loaded)
            return;
    }
    throw new Error(expectedLoaded
        ? `Daemon did not reach the running state (state: ${status.state || "not loaded"})`
        : `Daemon did not stop (state: ${status.state || "unknown"})`);
}
async function bootstrap(spawn, domain, plistPath) {
    let result;
    for (const delay of [0, 100, 250, 500, 1_000]) {
        if (delay)
            await new Promise((resolve) => setTimeout(resolve, delay));
        result = run(spawn, "launchctl", ["bootstrap", domain, plistPath], true);
        if (!result.error && result.status === 0)
            return;
    }
    const detail = resultText(result?.stderr) ||
        resultText(result?.stdout) ||
        result?.error?.message ||
        "unknown error";
    throw new Error(`launchctl bootstrap failed: ${detail}`);
}
async function runDarwinDaemonService(port, argv, writer, dependencies = {}) {
    const action = argv[0] || "status";
    const allowed = new Set([
        "install",
        "start",
        "stop",
        "restart",
        "status",
        "uninstall",
    ]);
    if (!allowed.has(action))
        throw new Error(`Unknown daemon command: ${action}`);
    const trailing = argv.slice(1);
    const confirm = action === "uninstall" && trailing.includes("--confirm");
    const invalidOption = action === "uninstall"
        ? trailing.find((value) => value !== "--confirm")
        : trailing[0];
    if (invalidOption) {
        throw new Error(`Unknown daemon option: ${argv.slice(1).join(" ")}`);
    }
    const spawn = dependencies.spawn || spawnSync;
    const homeDir = dependencies.homeDir || os.homedir();
    const uid = dependencies.uid ?? process.getuid?.();
    if (uid === undefined)
        throw new Error("Could not determine current user ID");
    const launchAgentsDir = path.join(homeDir, "Library", "LaunchAgents");
    const logsDir = path.join(homeDir, "Library", "Logs");
    const plistPath = path.join(launchAgentsDir, `${DAEMON_SERVICE_LABEL}.plist`);
    const logPath = path.join(logsDir, "gateway-for-premiere.log");
    const domain = `gui/${uid}`;
    const target = `${domain}/${DAEMON_SERVICE_LABEL}`;
    const delays = dependencies.waitDelays || [0, 50, 100, 250, 500, 1_000];
    const serviceStatus = async () => {
        const installed = await exists(plistPath);
        return {
            ok: true,
            service: DAEMON_SERVICE_LABEL,
            plist: plistPath,
            log: logPath,
            installed,
            port: installed ? await installedPort(plistPath) : null,
            ...statusValue(spawn, target),
        };
    };
    if (action === "status") {
        writer(`${JSON.stringify(await serviceStatus(), null, 2)}\n`);
        return;
    }
    if (action === "install") {
        await mkdir(launchAgentsDir, { recursive: true });
        await mkdir(logsDir, { recursive: true });
        const nodePath = dependencies.nodePath || process.execPath;
        const entrypoint = dependencies.entrypoint || process.argv[1];
        if (!entrypoint)
            throw new Error("Could not determine gateway-for-premiere entrypoint");
        const pathValue = dependencies.pathValue ||
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
        await writeFile(temporaryPath, buildLaunchAgentPlist({
            nodePath,
            entrypoint,
            logPath,
            pathValue,
            port,
        }), { encoding: "utf8", mode: 0o644 });
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
        if (!confirm)
            throw new Error("daemon uninstall requires --confirm");
        run(spawn, "launchctl", ["bootout", target], true);
        await waitFor(spawn, target, false, delays);
        await rm(plistPath, { force: true });
        writer(`${JSON.stringify(await serviceStatus(), null, 2)}\n`);
        return;
    }
    if (!(await exists(plistPath))) {
        throw new Error("Daemon is not installed; run `gateway-for-premiere daemon install`");
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
function windowsCommandValue(value) {
    return value.replaceAll("%", "%%");
}
function windowsProcessRunning(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
async function windowsPid(pidPath, processRunning) {
    try {
        const pid = Number((await readFile(pidPath, "utf8")).trim());
        return Number.isInteger(pid) && pid > 0 && processRunning(pid) ? pid : null;
    }
    catch {
        return null;
    }
}
async function waitForWindows(pidPath, expectedRunning, processRunning, delays) {
    let pid = await windowsPid(pidPath, processRunning);
    for (const delay of delays) {
        if (delay)
            await new Promise((resolve) => setTimeout(resolve, delay));
        pid = await windowsPid(pidPath, processRunning);
        if (expectedRunning ? pid !== null : pid === null)
            return;
    }
    throw new Error(expectedRunning
        ? "Daemon did not reach the running state"
        : `Daemon did not stop (pid: ${pid ?? "unknown"})`);
}
async function runWindowsDaemonService(port, argv, writer, dependencies) {
    const action = argv[0] || "status";
    const allowed = new Set([
        "install",
        "start",
        "stop",
        "restart",
        "status",
        "uninstall",
    ]);
    if (!allowed.has(action))
        throw new Error(`Unknown daemon command: ${action}`);
    const trailing = argv.slice(1);
    const confirm = action === "uninstall" && trailing.includes("--confirm");
    const invalidOption = action === "uninstall"
        ? trailing.find((value) => value !== "--confirm")
        : trailing[0];
    if (invalidOption)
        throw new Error(`Unknown daemon option: ${trailing.join(" ")}`);
    const spawn = dependencies.spawn || spawnSync;
    const localAppData = dependencies.localAppData || process.env.LOCALAPPDATA || os.homedir();
    const serviceDir = path.join(localAppData, "Gateway for Premiere");
    const configPath = path.join(serviceDir, "daemon.json");
    const launcherPath = path.join(serviceDir, "daemon.cmd");
    const logPath = path.join(serviceDir, "gateway-for-premiere.log");
    const pidPath = path.join(serviceDir, "gateway-for-premiere.pid");
    const delays = dependencies.waitDelays || [0, 100, 250, 500, 1_000, 2_000];
    const processRunning = dependencies.processRunning || windowsProcessRunning;
    const spawnDetached = dependencies.spawnDetached || spawnProcess;
    const readConfig = async () => {
        try {
            return JSON.parse(await readFile(configPath, "utf8"));
        }
        catch {
            return null;
        }
    };
    const taskExists = () => {
        const result = run(spawn, "schtasks.exe", ["/Query", "/TN", WINDOWS_DAEMON_TASK], true);
        return !result.error && result.status === 0;
    };
    const serviceStatus = async () => {
        const config = await readConfig();
        const pid = await windowsPid(config?.pidPath || pidPath, processRunning);
        const installed = config !== null && taskExists();
        return {
            ok: true,
            service: WINDOWS_DAEMON_TASK,
            config: configPath,
            log: config?.logPath || logPath,
            installed,
            port: config?.port ?? null,
            loaded: pid !== null,
            state: pid !== null ? "running" : installed ? "stopped" : null,
            pid,
        };
    };
    const startDetached = (config) => {
        const log = openSync(config.logPath, "a");
        try {
            const child = spawnDetached(config.nodePath, [config.entrypoint, "daemon"], {
                detached: true,
                windowsHide: true,
                stdio: ["ignore", log, log],
                env: {
                    ...process.env,
                    GATEWAY_FOR_PREMIERE_PORT: String(config.port),
                    GATEWAY_FOR_PREMIERE_PID_FILE: config.pidPath,
                },
            });
            child.unref();
        }
        finally {
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
    if (action === "install") {
        const previousConfig = await readConfig();
        const previousPid = await windowsPid(previousConfig?.pidPath || pidPath, processRunning);
        if (previousPid !== null) {
            run(spawn, "taskkill.exe", ["/PID", String(previousPid), "/T", "/F"], true);
            await waitForWindows(previousConfig?.pidPath || pidPath, false, processRunning, delays);
        }
        const nodePath = dependencies.nodePath || process.execPath;
        const entrypoint = dependencies.entrypoint || process.argv[1];
        if (!entrypoint)
            throw new Error("Could not determine gateway-for-premiere entrypoint");
        await mkdir(serviceDir, { recursive: true });
        const config = {
            nodePath,
            entrypoint,
            logPath,
            pidPath,
            port,
        };
        await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
        const launcher = [
            "@echo off",
            `set "GATEWAY_FOR_PREMIERE_PORT=${port}"`,
            `set "GATEWAY_FOR_PREMIERE_PID_FILE=${windowsCommandValue(pidPath)}"`,
            `"${windowsCommandValue(nodePath)}" "${windowsCommandValue(entrypoint)}" daemon >> "${windowsCommandValue(logPath)}" 2>&1`,
            "",
        ].join("\r\n");
        await writeFile(launcherPath, launcher, "utf8");
        run(spawn, "schtasks.exe", [
            "/Create",
            "/TN",
            WINDOWS_DAEMON_TASK,
            "/SC",
            "ONLOGON",
            "/TR",
            `cmd.exe /d /s /c ""${launcherPath}""`,
            "/F",
        ]);
        startDetached(config);
        await waitForWindows(pidPath, true, processRunning, delays);
        writer(`${JSON.stringify(await serviceStatus(), null, 2)}\n`);
        return;
    }
    const config = await readConfig();
    if (!config || !taskExists()) {
        throw new Error("Daemon is not installed; run `gateway-for-premiere daemon install`");
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
        run(spawn, "schtasks.exe", ["/Delete", "/TN", WINDOWS_DAEMON_TASK, "/F"]);
        await rm(serviceDir, { recursive: true, force: true });
        writer(`${JSON.stringify(await serviceStatus(), null, 2)}\n`);
        return;
    }
    if (action === "start" || action === "restart") {
        startDetached(config);
        await waitForWindows(config.pidPath, true, processRunning, delays);
    }
    writer(`${JSON.stringify(await serviceStatus(), null, 2)}\n`);
}
export async function runDaemonService(port, argv, writer, dependencies = {}) {
    const platform = dependencies.platform || process.platform;
    if (platform === "darwin") {
        return runDarwinDaemonService(port, argv, writer, dependencies);
    }
    if (platform === "win32") {
        return runWindowsDaemonService(port, argv, writer, dependencies);
    }
    throw new Error("Managed daemon commands are supported on macOS and Windows only");
}
