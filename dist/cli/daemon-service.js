import { spawnSync } from "node:child_process";
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
export async function runDaemonService(port, argv, writer, dependencies = {}) {
    if ((dependencies.platform || process.platform) !== "darwin") {
        throw new Error("Managed daemon commands are supported on macOS only");
    }
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
