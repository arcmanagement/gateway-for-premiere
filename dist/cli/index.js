#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { copyFile, lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { GATEWAY_PROTOCOL_TOKEN, resolvePort, } from "./config.js";
import { runDaemonService, } from "./daemon-service.js";
import { buildDoctorReport, } from "./doctor.js";
import { GatewayServer } from "../server/gateway.js";
import { MUTATION_OPERATIONS, } from "../shared/protocol.js";
const HELP = `premiere-gateway — CLI + token-gated loopback broker + Premiere UXP Plugin

Usage:
  premiere-gateway --help
  premiere-gateway daemon
  premiere-gateway daemon install
  premiere-gateway daemon start|stop|restart|status
  premiere-gateway daemon uninstall --confirm
  premiere-gateway doctor
  premiere-gateway status
  premiere-gateway snapshot [--depth N] [--session ID]
  premiere-gateway plugin build [--mode panel|invisible] [--distribution development|marketplace]
  premiere-gateway capabilities
  premiere-gateway journal [--limit N] [--session ID]
  premiere-gateway project [--session ID]
  premiere-gateway project recovery [--session ID]
  premiere-gateway project items [--depth N] [--session ID]
  premiere-gateway project save --expect-project GUID [--session ID] --confirm
  premiere-gateway project backup --output ABSOLUTE_PATH --expect-project GUID [--session ID] --confirm
  premiere-gateway project import --input ABSOLUTE_PATH --expect-items-revision REVISION EXPECTATIONS --confirm
  premiere-gateway project item remove --item-id ID --expect-items-revision REVISION EXPECTATIONS --confirm
  premiere-gateway sequence [--session ID]
  premiere-gateway sequence export --output ABSOLUTE_PATH --preset PRESET.epr EXPECTATIONS --confirm
  premiere-gateway timeline trim --item-ref REF --expect-revision REVISION \
    --expect-project GUID --expect-sequence GUID [--start-seconds N] [--end-seconds N] \
    [--session ID] --confirm
  premiere-gateway timeline insert --project-item ID --time-seconds N \
    --video-track N --audio-track N [--mode insert|overwrite] EXPECTATIONS --confirm
  premiere-gateway timeline move --item-ref REF --offset-seconds N EXPECTATIONS --confirm
  premiere-gateway timeline clone --item-ref REF --offset-seconds N EXPECTATIONS --confirm
  premiere-gateway timeline remove --item-ref REF [--ripple true|false] EXPECTATIONS --confirm
  premiere-gateway timeline update --item-ref REF [--name NAME] [--disabled true|false] EXPECTATIONS --confirm
  premiere-gateway timeline track rename --media-type video|audio --track N --name NAME EXPECTATIONS --confirm
  premiere-gateway timeline mogrt insert --input ABSOLUTE_PATH --time-seconds N --video-track N --audio-track N EXPECTATIONS --confirm
  premiere-gateway timeline marker add --name NAME --time-seconds N [--duration-seconds N] [--comments TEXT] [--type comment|chapter|weblink|flv-cue-point] EXPECTATIONS --confirm
  premiere-gateway timeline marker update --marker-guid GUID [--name NAME] [--duration-seconds N] [--comments TEXT] [--type comment|chapter|weblink|flv-cue-point] [--color-index 0..6] EXPECTATIONS --confirm
  premiere-gateway timeline marker move --marker-guid GUID --time-seconds N EXPECTATIONS --confirm
  premiere-gateway timeline marker remove --marker-guid GUID EXPECTATIONS --confirm
  premiere-gateway timeline components --item-ref REF EXPECTATIONS
  premiere-gateway timeline transition add --item-ref REF --match-name NAME --position start|end EXPECTATIONS --confirm
  premiere-gateway timeline transition remove --item-ref REF --position start|end EXPECTATIONS --confirm
  premiere-gateway timeline effect add --item-ref VIDEO_REF --match-name NAME EXPECTATIONS --confirm
  premiere-gateway timeline effect add --item-ref AUDIO_REF --display-name NAME EXPECTATIONS --confirm
  premiere-gateway timeline effect remove --item-ref REF --component-index N EXPECTATIONS --confirm
  premiere-gateway timeline effect set-param --item-ref REF --component-index N \
    --param-index N --value JSON EXPECTATIONS --confirm
  premiere-gateway timeline effect set-keyframe --item-ref REF --component-index N \
    --param-index N --time-seconds N --value JSON [--interpolation linear|hold|bezier|time] EXPECTATIONS --confirm
  premiere-gateway timeline effect remove-keyframe --item-ref REF --component-index N \
    --param-index N --time-seconds N EXPECTATIONS --confirm

EXPECTATIONS:
  --expect-project GUID --expect-sequence GUID --expect-revision REVISION [--session ID]
  --request-id ID is a fail-closed idempotency key and is never replayed
  Incomplete snapshots require --allow-incomplete-revision true after visual review
  Opaque-transition-only snapshots also accept the narrower --allow-opaque-transitions true

`;
const EXPECTATION_OPTIONS = [
    "--expect-project",
    "--expect-sequence",
    "--expect-revision",
    "--session",
];
const MUTATION_OPTIONS = [
    "--confirm",
    "--request-id",
    "--allow-incomplete-revision",
    "--allow-opaque-transitions",
    ...EXPECTATION_OPTIONS,
];
function parseGlobal(argv) {
    const options = {};
    let index = 0;
    while (index < argv.length && argv[index]?.startsWith("--")) {
        const name = argv[index];
        if (name === "--help")
            return { options, remaining: ["help"] };
        if (name !== "--port")
            throw new Error(`Unknown global option: ${name}`);
        if (options.port !== undefined)
            throw new Error("Duplicate global option: --port");
        const value = argv[index + 1];
        if (!value)
            throw new Error("--port requires a value");
        options.port = value;
        index += 2;
    }
    return { options, remaining: argv.slice(index) };
}
function parse(argv) {
    const positionals = [];
    const options = new Map();
    for (let index = 0; index < argv.length; index += 1) {
        const value = argv[index];
        if (!value.startsWith("--")) {
            positionals.push(value);
            continue;
        }
        if (options.has(value))
            throw new Error(`Duplicate option: ${value}`);
        if (value === "--confirm") {
            options.set(value, true);
            continue;
        }
        const next = argv[index + 1];
        if (!next || next.startsWith("--"))
            throw new Error(`${value} requires a value`);
        options.set(value, next);
        index += 1;
    }
    return { positionals, options };
}
function ensureOptions(options, allowed) {
    const allowedSet = new Set(allowed);
    const unknown = [...options.keys()].find((name) => !allowedSet.has(name));
    if (unknown)
        throw new Error(`Unknown option: ${unknown}`);
}
function ensurePositionals(positionals, expected) {
    if (positionals.length !== expected.length ||
        positionals.some((value, index) => value !== expected[index])) {
        throw new Error(`Unknown command: ${positionals.join(" ")}`);
    }
}
function required(options, name) {
    const value = options.get(name);
    if (typeof value !== "string" || !value)
        throw new Error(`${name} is required`);
    return value;
}
function optionalNumber(options, name) {
    const value = options.get(name);
    if (value === undefined)
        return undefined;
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0)
        throw new Error(`${name} must be a non-negative number`);
    return number;
}
function numberOption(options, name, requiredValue = true) {
    const value = options.get(name);
    if (value === undefined) {
        if (requiredValue)
            throw new Error(`${name} is required`);
        return undefined;
    }
    const number = Number(value);
    if (!Number.isFinite(number))
        throw new Error(`${name} must be a number`);
    return number;
}
function integerOption(options, name, requiredValue = true) {
    const value = numberOption(options, name, requiredValue);
    if (value === undefined)
        return undefined;
    if (!Number.isInteger(value))
        throw new Error(`${name} must be an integer`);
    return value;
}
async function exportPaths(outputFile, presetFile) {
    if (!path.isAbsolute(outputFile) || !path.isAbsolute(presetFile))
        throw new Error("--output and --preset must be absolute paths");
    if (path.extname(presetFile).toLowerCase() !== ".epr")
        throw new Error("--preset must be an .epr file");
    const resolvedPreset = await realpath(presetFile);
    const resolvedParent = await realpath(path.dirname(outputFile));
    const resolvedOutput = path.join(resolvedParent, path.basename(outputFile));
    try {
        await lstat(resolvedOutput);
        throw new Error(`Export output already exists: ${resolvedOutput}`);
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
    }
    return { outputFile: resolvedOutput, presetFile: resolvedPreset };
}
async function newOutputPath(outputFile) {
    if (!path.isAbsolute(outputFile))
        throw new Error("--output must be an absolute path");
    const resolvedParent = await realpath(path.dirname(outputFile));
    const resolvedOutput = path.join(resolvedParent, path.basename(outputFile));
    try {
        await lstat(resolvedOutput);
        throw new Error(`Output already exists: ${resolvedOutput}`);
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
    }
    return resolvedOutput;
}
function booleanOption(options, name, fallback) {
    const value = options.get(name);
    if (value === undefined)
        return fallback;
    if (value === "true")
        return true;
    if (value === "false")
        return false;
    throw new Error(`${name} must be true or false`);
}
function jsonOption(options, name) {
    const value = required(options, name);
    try {
        return JSON.parse(value);
    }
    catch (error) {
        throw new Error(`${name} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
}
function expectations(options) {
    const allowOpaqueTransitions = booleanOption(options, "--allow-opaque-transitions");
    const allowIncompleteRevision = booleanOption(options, "--allow-incomplete-revision");
    return {
        expectedProjectGuid: required(options, "--expect-project"),
        expectedSequenceGuid: required(options, "--expect-sequence"),
        expectedRevision: required(options, "--expect-revision"),
        ...(allowOpaqueTransitions !== undefined ? { allowOpaqueTransitions } : {}),
        ...(allowIncompleteRevision !== undefined
            ? { allowIncompleteRevision }
            : {}),
        ...requestIdArgument(options),
    };
}
function requestIdArgument(options) {
    const value = options.get("--request-id");
    if (value === true)
        throw new Error("--request-id requires a value");
    return typeof value === "string" ? { requestId: value } : {};
}
function output(writer, value) {
    writer(`${JSON.stringify(value, null, 2)}\n`);
}
async function responseJson(response) {
    const text = await response.text();
    try {
        return JSON.parse(text);
    }
    catch {
        throw new Error(`Gateway returned non-JSON response (${response.status}): ${text.slice(0, 160)}`);
    }
}
async function gatewayFetch(fetcher, input, init, timeoutMs) {
    try {
        return await fetcher(input, {
            ...init,
            ...(init.signal || timeoutMs
                ? { signal: init.signal || AbortSignal.timeout(timeoutMs) }
                : {}),
        });
    }
    catch (error) {
        throw new Error(`Could not reach Premiere Gateway: ${error instanceof Error ? error.message : String(error)}`);
    }
}
async function call(fetcher, port, operation, args, sessionId) {
    const explicitRequestId = args.requestId;
    const operationRequestId = MUTATION_OPERATIONS.has(operation)
        ? typeof explicitRequestId === "string"
            ? explicitRequestId
            : randomUUID()
        : undefined;
    const operationArgs = { ...args };
    delete operationArgs.requestId;
    let response;
    try {
        response = await gatewayFetch(fetcher, `http://127.0.0.1:${port}/rpc`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-premiere-gateway-token": GATEWAY_PROTOCOL_TOKEN,
            },
            body: JSON.stringify({
                operation,
                arguments: operationArgs,
                ...(sessionId ? { sessionId } : {}),
                ...(operationRequestId ? { requestId: operationRequestId } : {}),
            }),
        });
    }
    catch (error) {
        throw new Error(`${error instanceof Error ? error.message : String(error)}${operationRequestId ? ` (request ${operationRequestId})` : ""}`);
    }
    const value = await responseJson(response);
    if (!response.ok || !value.ok) {
        const failedRequestId = value.requestId || operationRequestId;
        throw new Error(`${value.error || `Gateway request failed: ${response.status}`}${failedRequestId ? ` (request ${failedRequestId})` : ""}`);
    }
    if (operationRequestId &&
        value.result &&
        typeof value.result === "object" &&
        !Array.isArray(value.result)) {
        return {
            ...value.result,
            requestId: value.requestId || operationRequestId,
        };
    }
    return value.result;
}
async function refreshDoctorHealth(fetcher, port, health) {
    if (!Array.isArray(health.sessions))
        return health;
    const sessions = await Promise.all(health.sessions.map(async (session) => {
        if (typeof session.sessionId !== "string")
            return session;
        const refreshed = { ...session };
        delete refreshed.projectGuid;
        delete refreshed.projectName;
        delete refreshed.sequenceGuid;
        delete refreshed.sequenceName;
        try {
            const value = await call(fetcher, port, "get_active_project", {}, session.sessionId);
            if (!value || typeof value !== "object" || Array.isArray(value)) {
                return refreshed;
            }
            const project = value;
            if (typeof project.guid === "string")
                refreshed.projectGuid = project.guid;
            if (typeof project.name === "string")
                refreshed.projectName = project.name;
            if (project.activeSequence &&
                typeof project.activeSequence === "object" &&
                !Array.isArray(project.activeSequence)) {
                const sequence = project.activeSequence;
                if (typeof sequence.guid === "string")
                    refreshed.sequenceGuid = sequence.guid;
                if (typeof sequence.name === "string")
                    refreshed.sequenceName = sequence.name;
            }
        }
        catch {
            // A connected Plugin can legitimately have no open project yet. The
            // cleared fields make that state explicit instead of reporting the
            // last project observed by the broker.
        }
        return refreshed;
    }));
    return { ...health, sessions };
}
async function foregroundDaemon(port, writer) {
    const server = new GatewayServer(port, GATEWAY_PROTOCOL_TOKEN);
    try {
        await server.start();
    }
    catch (error) {
        throw new Error(`Could not start Premiere Gateway on port ${port}: ${error instanceof Error ? error.message : String(error)}`);
    }
    output(writer, { ok: true, port: server.port });
    await new Promise((resolve) => {
        process.once("SIGINT", resolve);
        process.once("SIGTERM", resolve);
    });
    await server.close();
}
export async function runCli(argv, writer = (value) => process.stdout.write(value), dependencies = {}) {
    const { options: global, remaining } = parseGlobal(argv);
    const port = resolvePort(global.port);
    const fetcher = dependencies.fetch || fetch;
    const command = remaining[0];
    if (!command || command === "help") {
        writer(HELP);
        return;
    }
    const parsed = parse(remaining);
    const [parsedCommand, action] = parsed.positionals;
    if (parsedCommand === "daemon") {
        if (parsed.positionals.length === 1) {
            ensureOptions(parsed.options, []);
            return foregroundDaemon(port, writer);
        }
        return runDaemonService(port, remaining.slice(1), writer, dependencies.daemonService);
    }
    if (parsedCommand === "doctor") {
        ensurePositionals(parsed.positionals, ["doctor"]);
        ensureOptions(parsed.options, []);
        let daemon = {};
        try {
            let daemonOutput = "";
            await runDaemonService(port, ["status"], (value) => {
                daemonOutput += value;
            }, dependencies.daemonService);
            daemon = JSON.parse(daemonOutput);
        }
        catch (error) {
            daemon = {
                error: error instanceof Error ? error.message : String(error),
            };
        }
        let health;
        let brokerError;
        try {
            const response = await gatewayFetch(fetcher, `http://127.0.0.1:${port}/health`, { headers: { "x-premiere-gateway-token": GATEWAY_PROTOCOL_TOKEN } }, 5_000);
            const value = await responseJson(response);
            if (!response.ok || !value.ok) {
                brokerError =
                    value.error || `Gateway health failed: ${response.status}`;
            }
            else {
                health = await refreshDoctorHealth(fetcher, port, value);
            }
        }
        catch (error) {
            brokerError = error instanceof Error ? error.message : String(error);
        }
        return output(writer, buildDoctorReport({
            port,
            daemon,
            ...(health ? { health } : {}),
            ...(brokerError ? { brokerError } : {}),
        }));
    }
    if (parsedCommand === "status") {
        ensurePositionals(parsed.positionals, ["status"]);
        ensureOptions(parsed.options, []);
        try {
            const response = await gatewayFetch(fetcher, `http://127.0.0.1:${port}/health`, { headers: { "x-premiere-gateway-token": GATEWAY_PROTOCOL_TOKEN } }, 5_000);
            const value = await responseJson(response);
            if (!response.ok)
                throw new Error(value.error || `Gateway health failed: ${response.status}`);
            return output(writer, value);
        }
        catch (error) {
            return output(writer, {
                ok: false,
                port,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
    if (parsedCommand === "plugin" && action === "build") {
        ensurePositionals(parsed.positionals, ["plugin", "build"]);
        ensureOptions(parsed.options, ["--mode", "--distribution"]);
        const mode = String(parsed.options.get("--mode") || "panel");
        if (mode !== "panel" && mode !== "invisible") {
            throw new Error("--mode must be panel or invisible");
        }
        const distribution = String(parsed.options.get("--distribution") || "development");
        if (distribution !== "development" && distribution !== "marketplace") {
            throw new Error("--distribution must be development or marketplace");
        }
        const root = fileURLToPath(new URL("../../", import.meta.url));
        const result = (dependencies.spawn || spawnSync)("node", [path.join(root, "scripts", "build-plugin.mjs")], {
            cwd: root,
            env: {
                ...process.env,
                PREMIERE_GATEWAY_PORT: String(port),
                PREMIERE_GATEWAY_PLUGIN_MODE: mode,
                PREMIERE_GATEWAY_PLUGIN_DISTRIBUTION: distribution,
            },
            encoding: "utf8",
        });
        if (result.status !== 0 || result.error) {
            throw new Error(String(result.stderr || result.stdout || result.error?.message).trim());
        }
        return output(writer, { manifest: String(result.stdout).trim() });
    }
    const session = typeof parsed.options.get("--session") === "string"
        ? String(parsed.options.get("--session"))
        : undefined;
    if (parsedCommand === "capabilities" && action === undefined) {
        ensurePositionals(parsed.positionals, ["capabilities"]);
        ensureOptions(parsed.options, ["--session"]);
        return output(writer, await call(fetcher, port, "get_editing_capabilities", {}, session));
    }
    if (parsedCommand === "journal" && action === undefined) {
        ensurePositionals(parsed.positionals, ["journal"]);
        ensureOptions(parsed.options, ["--limit", "--session"]);
        const limit = integerOption(parsed.options, "--limit", false);
        if (limit !== undefined && (limit < 1 || limit > 500))
            throw new Error("--limit must be an integer from 1 to 500");
        return output(writer, await call(fetcher, port, "get_request_journal", limit === undefined ? {} : { limit }, session));
    }
    if (parsedCommand === "snapshot" && action === undefined) {
        ensurePositionals(parsed.positionals, ["snapshot"]);
        ensureOptions(parsed.options, ["--depth", "--session"]);
        const maxDepth = integerOption(parsed.options, "--depth", false);
        if (maxDepth !== undefined && (maxDepth < 0 || maxDepth > 32))
            throw new Error("--depth must be an integer from 0 to 32");
        return output(writer, await call(fetcher, port, "get_editing_snapshot", maxDepth === undefined ? {} : { maxDepth }, session));
    }
    if (parsedCommand === "project" && action === undefined) {
        ensurePositionals(parsed.positionals, ["project"]);
        ensureOptions(parsed.options, ["--session"]);
        return output(writer, await call(fetcher, port, "get_active_project", {}, session));
    }
    if (parsedCommand === "project" && action === "recovery") {
        ensurePositionals(parsed.positionals, ["project", "recovery"]);
        ensureOptions(parsed.options, ["--session"]);
        return output(writer, await call(fetcher, port, "get_project_recovery", {}, session));
    }
    if (parsedCommand === "project" && action === "items") {
        ensurePositionals(parsed.positionals, ["project", "items"]);
        ensureOptions(parsed.options, ["--depth", "--session"]);
        const maxDepth = integerOption(parsed.options, "--depth", false);
        if (maxDepth !== undefined && (maxDepth < 0 || maxDepth > 32))
            throw new Error("--depth must be an integer from 0 to 32");
        return output(writer, await call(fetcher, port, "get_project_items", maxDepth === undefined ? {} : { maxDepth }, session));
    }
    if (parsedCommand === "sequence" && action === undefined) {
        ensurePositionals(parsed.positionals, ["sequence"]);
        ensureOptions(parsed.options, ["--session"]);
        return output(writer, await call(fetcher, port, "get_active_sequence", {}, session));
    }
    if (parsedCommand === "sequence" && action === "export") {
        ensurePositionals(parsed.positionals, ["sequence", "export"]);
        ensureOptions(parsed.options, [
            ...MUTATION_OPTIONS,
            "--output",
            "--preset",
            "--full",
        ]);
        if (!parsed.options.has("--confirm"))
            throw new Error("sequence export requires --confirm");
        const paths = await exportPaths(required(parsed.options, "--output"), required(parsed.options, "--preset"));
        return output(writer, await call(fetcher, port, "export_sequence", {
            confirm: true,
            ...expectations(parsed.options),
            ...paths,
            exportFull: booleanOption(parsed.options, "--full", true),
        }, session));
    }
    if (parsedCommand === "project" && action === "backup") {
        ensurePositionals(parsed.positionals, ["project", "backup"]);
        ensureOptions(parsed.options, [
            "--confirm",
            "--request-id",
            "--output",
            "--expect-project",
            "--session",
        ]);
        if (!parsed.options.has("--confirm"))
            throw new Error("project backup requires --confirm");
        const expectedProjectGuid = required(parsed.options, "--expect-project");
        const projectInfo = (await call(fetcher, port, "get_active_project", {}, session));
        if (String(projectInfo.guid || "") !== expectedProjectGuid)
            throw new Error("Active project changed; read it again");
        const sourceFile = await realpath(String(projectInfo.path || ""));
        if (path.extname(sourceFile).toLowerCase() !== ".prproj")
            throw new Error("Active project is not a .prproj file");
        const outputFile = await newOutputPath(required(parsed.options, "--output"));
        const saveResult = (await call(fetcher, port, "save_project", {
            confirm: true,
            expectedProjectGuid,
            ...requestIdArgument(parsed.options),
        }, session));
        await copyFile(sourceFile, outputFile, fsConstants.COPYFILE_EXCL);
        const copied = await stat(outputFile);
        return output(writer, {
            backedUp: true,
            projectGuid: expectedProjectGuid,
            sourceFile,
            outputFile,
            bytes: copied.size,
            requestId: saveResult.requestId,
        });
    }
    if (parsedCommand === "project" && action === "save") {
        ensurePositionals(parsed.positionals, ["project", "save"]);
        ensureOptions(parsed.options, [
            "--confirm",
            "--request-id",
            "--expect-project",
            "--session",
        ]);
        if (!parsed.options.has("--confirm"))
            throw new Error("project save requires --confirm");
        return output(writer, await call(fetcher, port, "save_project", {
            confirm: true,
            expectedProjectGuid: required(parsed.options, "--expect-project"),
            ...requestIdArgument(parsed.options),
        }, session));
    }
    if (parsedCommand === "project" && action === "import") {
        ensurePositionals(parsed.positionals, ["project", "import"]);
        ensureOptions(parsed.options, [
            ...MUTATION_OPTIONS,
            "--input",
            "--expect-items-revision",
        ]);
        if (!parsed.options.has("--confirm"))
            throw new Error("project import requires --confirm");
        const inputFile = await realpath(required(parsed.options, "--input"));
        const inputStat = await stat(inputFile);
        if (!inputStat.isFile())
            throw new Error("--input must be a file");
        if (path.extname(inputFile).toLowerCase() === ".prproj")
            throw new Error("project import does not accept .prproj files");
        return output(writer, await call(fetcher, port, "import_media_file", {
            confirm: true,
            ...expectations(parsed.options),
            expectedProjectItemsRevision: required(parsed.options, "--expect-items-revision"),
            inputFile,
        }, session));
    }
    if (parsedCommand === "project" &&
        action === "item" &&
        parsed.positionals[2] === "remove") {
        ensurePositionals(parsed.positionals, ["project", "item", "remove"]);
        ensureOptions(parsed.options, [
            ...MUTATION_OPTIONS,
            "--item-id",
            "--expect-items-revision",
        ]);
        if (!parsed.options.has("--confirm"))
            throw new Error("project item remove requires --confirm");
        return output(writer, await call(fetcher, port, "remove_project_item", {
            confirm: true,
            ...expectations(parsed.options),
            expectedProjectItemsRevision: required(parsed.options, "--expect-items-revision"),
            projectItemId: required(parsed.options, "--item-id"),
        }, session));
    }
    if (parsedCommand === "timeline" &&
        action === "track" &&
        parsed.positionals[2] === "rename") {
        ensurePositionals(parsed.positionals, ["timeline", "track", "rename"]);
        ensureOptions(parsed.options, [
            ...MUTATION_OPTIONS,
            "--media-type",
            "--track",
            "--name",
        ]);
        if (!parsed.options.has("--confirm"))
            throw new Error("timeline track rename requires --confirm");
        const mediaType = required(parsed.options, "--media-type");
        if (mediaType !== "video" && mediaType !== "audio")
            throw new Error("--media-type must be video or audio");
        const trackIndex = integerOption(parsed.options, "--track");
        if (trackIndex < 0)
            throw new Error("--track must be >= 0");
        return output(writer, await call(fetcher, port, "update_track", {
            confirm: true,
            ...expectations(parsed.options),
            mediaType,
            trackIndex,
            name: required(parsed.options, "--name"),
        }, session));
    }
    if (parsedCommand === "timeline" && action === "trim") {
        ensurePositionals(parsed.positionals, ["timeline", "trim"]);
        ensureOptions(parsed.options, [
            ...MUTATION_OPTIONS,
            "--item-ref",
            "--start-seconds",
            "--end-seconds",
        ]);
        if (!parsed.options.has("--confirm"))
            throw new Error("timeline trim requires --confirm");
        const startSeconds = optionalNumber(parsed.options, "--start-seconds");
        const endSeconds = optionalNumber(parsed.options, "--end-seconds");
        if (startSeconds === undefined && endSeconds === undefined) {
            throw new Error("timeline trim requires --start-seconds or --end-seconds");
        }
        return output(writer, await call(fetcher, port, "trim_track_item", {
            confirm: true,
            itemRef: required(parsed.options, "--item-ref"),
            ...expectations(parsed.options),
            ...(startSeconds !== undefined ? { startSeconds } : {}),
            ...(endSeconds !== undefined ? { endSeconds } : {}),
        }, session));
    }
    if (parsedCommand === "timeline" && action === "insert") {
        ensurePositionals(parsed.positionals, ["timeline", "insert"]);
        ensureOptions(parsed.options, [
            ...MUTATION_OPTIONS,
            "--project-item",
            "--time-seconds",
            "--video-track",
            "--audio-track",
            "--mode",
            "--limit-shift",
        ]);
        if (!parsed.options.has("--confirm"))
            throw new Error("timeline insert requires --confirm");
        const mode = String(parsed.options.get("--mode") || "insert");
        if (!new Set(["insert", "overwrite"]).has(mode))
            throw new Error("--mode must be insert or overwrite");
        const timeSeconds = numberOption(parsed.options, "--time-seconds");
        const videoTrackIndex = integerOption(parsed.options, "--video-track");
        const audioTrackIndex = integerOption(parsed.options, "--audio-track");
        if (timeSeconds < 0)
            throw new Error("--time-seconds must be >= 0");
        if (videoTrackIndex < 0 || audioTrackIndex < 0)
            throw new Error("track indexes must be >= 0");
        return output(writer, await call(fetcher, port, "insert_project_item", {
            confirm: true,
            ...expectations(parsed.options),
            projectItemId: required(parsed.options, "--project-item"),
            timeSeconds,
            videoTrackIndex,
            audioTrackIndex,
            mode,
            limitShift: booleanOption(parsed.options, "--limit-shift", true),
        }, session));
    }
    if (parsedCommand === "timeline" && action === "move") {
        ensurePositionals(parsed.positionals, ["timeline", "move"]);
        ensureOptions(parsed.options, [
            ...MUTATION_OPTIONS,
            "--item-ref",
            "--offset-seconds",
        ]);
        if (!parsed.options.has("--confirm"))
            throw new Error("timeline move requires --confirm");
        return output(writer, await call(fetcher, port, "move_track_item", {
            confirm: true,
            ...expectations(parsed.options),
            itemRef: required(parsed.options, "--item-ref"),
            offsetSeconds: numberOption(parsed.options, "--offset-seconds"),
        }, session));
    }
    if (parsedCommand === "timeline" && action === "clone") {
        ensurePositionals(parsed.positionals, ["timeline", "clone"]);
        ensureOptions(parsed.options, [
            ...MUTATION_OPTIONS,
            "--item-ref",
            "--offset-seconds",
            "--video-track-offset",
            "--audio-track-offset",
            "--align-to-video",
            "--insert",
        ]);
        if (!parsed.options.has("--confirm"))
            throw new Error("timeline clone requires --confirm");
        return output(writer, await call(fetcher, port, "clone_track_item", {
            confirm: true,
            ...expectations(parsed.options),
            itemRef: required(parsed.options, "--item-ref"),
            offsetSeconds: numberOption(parsed.options, "--offset-seconds"),
            videoTrackOffset: integerOption(parsed.options, "--video-track-offset", false) ?? 0,
            audioTrackOffset: integerOption(parsed.options, "--audio-track-offset", false) ?? 0,
            alignToVideo: booleanOption(parsed.options, "--align-to-video", true),
            insert: booleanOption(parsed.options, "--insert", false),
        }, session));
    }
    if (parsedCommand === "timeline" && action === "remove") {
        ensurePositionals(parsed.positionals, ["timeline", "remove"]);
        ensureOptions(parsed.options, [
            ...MUTATION_OPTIONS,
            "--item-ref",
            "--ripple",
            "--shift-overlapping",
        ]);
        if (!parsed.options.has("--confirm"))
            throw new Error("timeline remove requires --confirm");
        return output(writer, await call(fetcher, port, "remove_track_item", {
            confirm: true,
            ...expectations(parsed.options),
            itemRef: required(parsed.options, "--item-ref"),
            ripple: booleanOption(parsed.options, "--ripple", false),
            shiftOverlapping: booleanOption(parsed.options, "--shift-overlapping", false),
        }, session));
    }
    if (parsedCommand === "timeline" && action === "update") {
        ensurePositionals(parsed.positionals, ["timeline", "update"]);
        ensureOptions(parsed.options, [
            ...MUTATION_OPTIONS,
            "--item-ref",
            "--name",
            "--disabled",
        ]);
        if (!parsed.options.has("--confirm"))
            throw new Error("timeline update requires --confirm");
        const name = parsed.options.get("--name");
        const disabled = booleanOption(parsed.options, "--disabled");
        if (typeof name !== "string" && disabled === undefined)
            throw new Error("timeline update requires --name or --disabled");
        return output(writer, await call(fetcher, port, "update_track_item", {
            confirm: true,
            ...expectations(parsed.options),
            itemRef: required(parsed.options, "--item-ref"),
            ...(typeof name === "string" ? { name } : {}),
            ...(disabled !== undefined ? { disabled } : {}),
        }, session));
    }
    if (parsedCommand === "timeline" &&
        action === "mogrt" &&
        parsed.positionals[2] === "insert") {
        ensurePositionals(parsed.positionals, ["timeline", "mogrt", "insert"]);
        ensureOptions(parsed.options, [
            ...MUTATION_OPTIONS,
            "--input",
            "--time-seconds",
            "--video-track",
            "--audio-track",
        ]);
        if (!parsed.options.has("--confirm"))
            throw new Error("timeline mogrt insert requires --confirm");
        const inputFile = await realpath(required(parsed.options, "--input"));
        const inputStat = await stat(inputFile);
        if (!inputStat.isFile() ||
            path.extname(inputFile).toLowerCase() !== ".mogrt")
            throw new Error("--input must be a .mogrt file");
        const timeSeconds = numberOption(parsed.options, "--time-seconds");
        const videoTrackIndex = integerOption(parsed.options, "--video-track");
        const audioTrackIndex = integerOption(parsed.options, "--audio-track");
        if (timeSeconds < 0)
            throw new Error("--time-seconds must be >= 0");
        if (videoTrackIndex < 0 || audioTrackIndex < 0)
            throw new Error("track indexes must be >= 0");
        return output(writer, await call(fetcher, port, "insert_mogrt", {
            confirm: true,
            ...expectations(parsed.options),
            inputFile,
            timeSeconds,
            videoTrackIndex,
            audioTrackIndex,
        }, session));
    }
    if (parsedCommand === "timeline" &&
        action === "marker" &&
        parsed.positionals[2] === "add") {
        ensurePositionals(parsed.positionals, ["timeline", "marker", "add"]);
        ensureOptions(parsed.options, [
            ...MUTATION_OPTIONS,
            "--name",
            "--time-seconds",
            "--duration-seconds",
            "--comments",
            "--type",
        ]);
        if (!parsed.options.has("--confirm"))
            throw new Error("timeline marker add requires --confirm");
        const timeSeconds = numberOption(parsed.options, "--time-seconds");
        const durationSeconds = numberOption(parsed.options, "--duration-seconds", false);
        if (timeSeconds < 0)
            throw new Error("--time-seconds must be >= 0");
        if (durationSeconds !== undefined && durationSeconds < 0)
            throw new Error("--duration-seconds must be >= 0");
        return output(writer, await call(fetcher, port, "add_sequence_marker", {
            confirm: true,
            ...expectations(parsed.options),
            name: required(parsed.options, "--name"),
            timeSeconds,
            durationSeconds: durationSeconds ?? 0,
            comments: String(parsed.options.get("--comments") || ""),
            markerType: String(parsed.options.get("--type") || "comment"),
        }, session));
    }
    if (parsedCommand === "timeline" &&
        action === "marker" &&
        parsed.positionals[2] === "update") {
        ensurePositionals(parsed.positionals, ["timeline", "marker", "update"]);
        ensureOptions(parsed.options, [
            ...MUTATION_OPTIONS,
            "--marker-guid",
            "--name",
            "--duration-seconds",
            "--comments",
            "--type",
            "--color-index",
        ]);
        if (!parsed.options.has("--confirm"))
            throw new Error("timeline marker update requires --confirm");
        const name = parsed.options.get("--name");
        const comments = parsed.options.get("--comments");
        const markerType = parsed.options.get("--type");
        const durationSeconds = numberOption(parsed.options, "--duration-seconds", false);
        const colorIndex = integerOption(parsed.options, "--color-index", false);
        if (durationSeconds !== undefined && durationSeconds < 0)
            throw new Error("--duration-seconds must be >= 0");
        if (colorIndex !== undefined && (colorIndex < 0 || colorIndex > 6))
            throw new Error("--color-index must be an integer from 0 to 6");
        if (typeof name !== "string" &&
            typeof comments !== "string" &&
            typeof markerType !== "string" &&
            durationSeconds === undefined &&
            colorIndex === undefined) {
            throw new Error("timeline marker update requires a changed field");
        }
        return output(writer, await call(fetcher, port, "update_sequence_marker", {
            confirm: true,
            ...expectations(parsed.options),
            markerGuid: required(parsed.options, "--marker-guid"),
            ...(typeof name === "string" ? { name } : {}),
            ...(typeof comments === "string" ? { comments } : {}),
            ...(typeof markerType === "string" ? { markerType } : {}),
            ...(durationSeconds !== undefined ? { durationSeconds } : {}),
            ...(colorIndex !== undefined ? { colorIndex } : {}),
        }, session));
    }
    if (parsedCommand === "timeline" &&
        action === "marker" &&
        parsed.positionals[2] === "move") {
        ensurePositionals(parsed.positionals, ["timeline", "marker", "move"]);
        ensureOptions(parsed.options, [
            ...MUTATION_OPTIONS,
            "--marker-guid",
            "--time-seconds",
        ]);
        if (!parsed.options.has("--confirm"))
            throw new Error("timeline marker move requires --confirm");
        const timeSeconds = numberOption(parsed.options, "--time-seconds");
        if (timeSeconds < 0)
            throw new Error("--time-seconds must be >= 0");
        return output(writer, await call(fetcher, port, "move_sequence_marker", {
            confirm: true,
            ...expectations(parsed.options),
            markerGuid: required(parsed.options, "--marker-guid"),
            timeSeconds,
        }, session));
    }
    if (parsedCommand === "timeline" &&
        action === "marker" &&
        parsed.positionals[2] === "remove") {
        ensurePositionals(parsed.positionals, ["timeline", "marker", "remove"]);
        ensureOptions(parsed.options, [...MUTATION_OPTIONS, "--marker-guid"]);
        if (!parsed.options.has("--confirm"))
            throw new Error("timeline marker remove requires --confirm");
        return output(writer, await call(fetcher, port, "remove_sequence_marker", {
            confirm: true,
            ...expectations(parsed.options),
            markerGuid: required(parsed.options, "--marker-guid"),
        }, session));
    }
    if (parsedCommand === "timeline" && action === "components") {
        ensurePositionals(parsed.positionals, ["timeline", "components"]);
        ensureOptions(parsed.options, [...EXPECTATION_OPTIONS, "--item-ref"]);
        return output(writer, await call(fetcher, port, "get_track_item_components", {
            ...expectations(parsed.options),
            itemRef: required(parsed.options, "--item-ref"),
        }, session));
    }
    if (parsedCommand === "timeline" &&
        action === "transition" &&
        parsed.positionals[2] === "add") {
        ensurePositionals(parsed.positionals, ["timeline", "transition", "add"]);
        ensureOptions(parsed.options, [
            ...MUTATION_OPTIONS,
            "--item-ref",
            "--match-name",
            "--position",
            "--duration-seconds",
            "--force-single-sided",
        ]);
        if (!parsed.options.has("--confirm"))
            throw new Error("timeline transition add requires --confirm");
        const durationSeconds = numberOption(parsed.options, "--duration-seconds", false);
        if (durationSeconds !== undefined && durationSeconds <= 0)
            throw new Error("--duration-seconds must be > 0");
        return output(writer, await call(fetcher, port, "add_video_transition", {
            confirm: true,
            ...expectations(parsed.options),
            itemRef: required(parsed.options, "--item-ref"),
            matchName: required(parsed.options, "--match-name"),
            position: required(parsed.options, "--position"),
            forceSingleSided: booleanOption(parsed.options, "--force-single-sided", false),
            ...(durationSeconds !== undefined ? { durationSeconds } : {}),
        }, session));
    }
    if (parsedCommand === "timeline" &&
        action === "transition" &&
        parsed.positionals[2] === "remove") {
        ensurePositionals(parsed.positionals, ["timeline", "transition", "remove"]);
        ensureOptions(parsed.options, [
            ...MUTATION_OPTIONS,
            "--item-ref",
            "--position",
        ]);
        if (!parsed.options.has("--confirm"))
            throw new Error("timeline transition remove requires --confirm");
        return output(writer, await call(fetcher, port, "remove_video_transition", {
            confirm: true,
            ...expectations(parsed.options),
            itemRef: required(parsed.options, "--item-ref"),
            position: required(parsed.options, "--position"),
        }, session));
    }
    if (parsedCommand === "timeline" &&
        action === "effect" &&
        parsed.positionals[2] === "add") {
        ensurePositionals(parsed.positionals, ["timeline", "effect", "add"]);
        ensureOptions(parsed.options, [
            ...MUTATION_OPTIONS,
            "--item-ref",
            "--match-name",
            "--display-name",
            "--insertion-index",
        ]);
        if (!parsed.options.has("--confirm"))
            throw new Error("timeline effect add requires --confirm");
        const itemRef = required(parsed.options, "--item-ref");
        const audio = itemRef.startsWith("audio:");
        const insertionIndex = integerOption(parsed.options, "--insertion-index", false);
        const effectName = required(parsed.options, audio ? "--display-name" : "--match-name");
        if (parsed.options.has(audio ? "--match-name" : "--display-name")) {
            throw new Error(audio
                ? "Audio effects use --display-name, not --match-name"
                : "Video effects use --match-name, not --display-name");
        }
        return output(writer, await call(fetcher, port, audio ? "add_audio_effect" : "add_video_effect", {
            confirm: true,
            ...expectations(parsed.options),
            itemRef,
            ...(audio ? { displayName: effectName } : { matchName: effectName }),
            ...(insertionIndex !== undefined ? { insertionIndex } : {}),
        }, session));
    }
    if (parsedCommand === "timeline" &&
        action === "effect" &&
        parsed.positionals[2] === "remove") {
        ensurePositionals(parsed.positionals, ["timeline", "effect", "remove"]);
        ensureOptions(parsed.options, [
            ...MUTATION_OPTIONS,
            "--item-ref",
            "--component-index",
        ]);
        if (!parsed.options.has("--confirm"))
            throw new Error("timeline effect remove requires --confirm");
        const itemRef = required(parsed.options, "--item-ref");
        return output(writer, await call(fetcher, port, itemRef.startsWith("audio:")
            ? "remove_audio_effect"
            : "remove_video_effect", {
            confirm: true,
            ...expectations(parsed.options),
            itemRef,
            componentIndex: integerOption(parsed.options, "--component-index"),
        }, session));
    }
    if (parsedCommand === "timeline" &&
        action === "effect" &&
        parsed.positionals[2] === "set-param") {
        ensurePositionals(parsed.positionals, ["timeline", "effect", "set-param"]);
        ensureOptions(parsed.options, [
            ...MUTATION_OPTIONS,
            "--item-ref",
            "--component-index",
            "--param-index",
            "--value",
        ]);
        if (!parsed.options.has("--confirm"))
            throw new Error("timeline effect set-param requires --confirm");
        return output(writer, await call(fetcher, port, "set_component_param", {
            confirm: true,
            ...expectations(parsed.options),
            itemRef: required(parsed.options, "--item-ref"),
            componentIndex: integerOption(parsed.options, "--component-index"),
            paramIndex: integerOption(parsed.options, "--param-index"),
            value: jsonOption(parsed.options, "--value"),
        }, session));
    }
    if (parsedCommand === "timeline" &&
        action === "effect" &&
        parsed.positionals[2] === "set-keyframe") {
        ensurePositionals(parsed.positionals, [
            "timeline",
            "effect",
            "set-keyframe",
        ]);
        ensureOptions(parsed.options, [
            ...MUTATION_OPTIONS,
            "--item-ref",
            "--component-index",
            "--param-index",
            "--time-seconds",
            "--value",
            "--interpolation",
        ]);
        if (!parsed.options.has("--confirm"))
            throw new Error("timeline effect set-keyframe requires --confirm");
        const interpolation = parsed.options.get("--interpolation");
        if (interpolation === true)
            throw new Error("--interpolation requires a value");
        return output(writer, await call(fetcher, port, "set_component_keyframe", {
            confirm: true,
            ...expectations(parsed.options),
            itemRef: required(parsed.options, "--item-ref"),
            componentIndex: integerOption(parsed.options, "--component-index"),
            paramIndex: integerOption(parsed.options, "--param-index"),
            timeSeconds: numberOption(parsed.options, "--time-seconds"),
            value: jsonOption(parsed.options, "--value"),
            ...(interpolation ? { interpolation } : {}),
        }, session));
    }
    if (parsedCommand === "timeline" &&
        action === "effect" &&
        parsed.positionals[2] === "remove-keyframe") {
        ensurePositionals(parsed.positionals, [
            "timeline",
            "effect",
            "remove-keyframe",
        ]);
        ensureOptions(parsed.options, [
            ...MUTATION_OPTIONS,
            "--item-ref",
            "--component-index",
            "--param-index",
            "--time-seconds",
        ]);
        if (!parsed.options.has("--confirm"))
            throw new Error("timeline effect remove-keyframe requires --confirm");
        return output(writer, await call(fetcher, port, "remove_component_keyframe", {
            confirm: true,
            ...expectations(parsed.options),
            itemRef: required(parsed.options, "--item-ref"),
            componentIndex: integerOption(parsed.options, "--component-index"),
            paramIndex: integerOption(parsed.options, "--param-index"),
            timeSeconds: numberOption(parsed.options, "--time-seconds"),
        }, session));
    }
    throw new Error(`Unknown command: ${remaining.join(" ")}`);
}
async function isEntrypoint() {
    if (!process.argv[1])
        return false;
    try {
        return ((await realpath(process.argv[1])) ===
            (await realpath(fileURLToPath(import.meta.url))));
    }
    catch {
        return pathToFileURL(process.argv[1]).href === import.meta.url;
    }
}
if (await isEntrypoint()) {
    runCli(process.argv.slice(2)).catch((error) => {
        process.stderr.write(`ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    });
}
