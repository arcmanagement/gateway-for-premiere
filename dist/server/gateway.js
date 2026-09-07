import { randomUUID, timingSafeEqual } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { copyFile, lstat, link, realpath, stat, unlink, } from "node:fs/promises";
import { createServer, } from "node:http";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { DEFAULT_PLUGIN_TIMEOUT_MS, EXPORT_PLUGIN_TIMEOUT_MS, MUTATION_OPERATIONS, READ_OPERATIONS, } from "../shared/protocol.js";
function writeJson(response, status, value) {
    const body = JSON.stringify(value);
    response.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(body),
    });
    response.end(body);
}
async function readJson(request) {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
        const buffer = Buffer.from(chunk);
        size += buffer.byteLength;
        if (size > 1024 * 1024)
            throw new Error("Request body exceeds 1 MiB");
        chunks.push(buffer);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function authorized(actual, expected) {
    const left = Buffer.from(actual);
    const right = Buffer.from(expected);
    return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}
function isPremierePluginOrigin(origin) {
    return origin === "file://";
}
function isOperation(value) {
    return (READ_OPERATIONS.has(value) ||
        MUTATION_OPERATIONS.has(value));
}
function requestId(value) {
    if (value === undefined)
        return randomUUID();
    if (typeof value !== "string" ||
        value.length < 8 ||
        value.length > 128 ||
        !/^[A-Za-z0-9._:-]+$/.test(value)) {
        throw new Error("requestId must be 8-128 characters using letters, numbers, dot, underscore, colon, or hyphen");
    }
    return value;
}
const LINK_UNSUPPORTED_CODES = new Set([
    "ENOSYS",
    "ENOTSUP",
    "EOPNOTSUPP",
    "EPERM",
    "EXDEV",
]);
export async function finalizeExportFile(stagingFile, outputFile, createLink = link, copy = copyFile) {
    try {
        await createLink(stagingFile, outputFile);
    }
    catch (error) {
        const code = error.code;
        if (!code || !LINK_UNSUPPORTED_CODES.has(code))
            throw error;
        await copy(stagingFile, outputFile, fsConstants.COPYFILE_EXCL);
    }
}
export class GatewayServer {
    port;
    protocolToken;
    now;
    server;
    connections = new Map();
    pending = new Map();
    constructor(port, protocolToken, now = Date.now) {
        this.port = port;
        this.protocolToken = protocolToken;
        this.now = now;
        if (!protocolToken)
            throw new Error("Gateway protocol token is required");
    }
    async start() {
        const server = createServer(async (request, response) => {
            let rpcRequestId;
            try {
                if (!authorized(String(request.headers["x-gateway-for-premiere-token"] || ""), this.protocolToken)) {
                    writeJson(response, 401, {
                        ok: false,
                        error: "Invalid gateway protocol token",
                    });
                    return;
                }
                if (request.method === "GET" && request.url === "/health") {
                    writeJson(response, 200, { ok: true, sessions: this.listSessions() });
                    return;
                }
                if (request.method === "POST" && request.url === "/rpc") {
                    const value = (await readJson(request));
                    if (!isOperation(value.operation))
                        throw new Error("Unsupported Premiere operation");
                    rpcRequestId = requestId(value.requestId);
                    const result = await this.call(value.operation, value.arguments || {}, typeof value.sessionId === "string" ? value.sessionId : undefined, rpcRequestId);
                    writeJson(response, 200, {
                        ok: true,
                        result,
                        requestId: rpcRequestId,
                    });
                    return;
                }
                writeJson(response, 404, { ok: false, error: "Not found" });
            }
            catch (error) {
                writeJson(response, 400, {
                    ok: false,
                    error: error instanceof Error ? error.message : String(error),
                    ...(rpcRequestId ? { requestId: rpcRequestId } : {}),
                });
            }
        });
        const sockets = new WebSocketServer({
            noServer: true,
            maxPayload: 4 * 1024 * 1024,
        });
        server.on("upgrade", (request, socket, head) => {
            if (request.url !== "/plugin" ||
                !isPremierePluginOrigin(request.headers.origin)) {
                socket.destroy();
                return;
            }
            sockets.handleUpgrade(request, socket, head, (websocket) => sockets.emit("connection", websocket));
        });
        sockets.on("connection", (socket) => this.acceptPlugin(socket));
        await new Promise((resolve, reject) => {
            const onError = (error) => reject(error);
            server.once("error", onError);
            server.listen(this.port, "127.0.0.1", () => {
                server.off("error", onError);
                this.server = server;
                resolve();
            });
        });
    }
    listSessions() {
        return [...this.connections.values()].map(({ session }) => session);
    }
    async close() {
        for (const { socket } of this.connections.values())
            socket.close();
        this.connections.clear();
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(new Error("Gateway closed"));
        }
        this.pending.clear();
        if (!this.server)
            return;
        await new Promise((resolve, reject) => {
            this.server?.close((error) => (error ? reject(error) : resolve()));
        });
        this.server = undefined;
    }
    async call(operation, payload, requestedSessionId, requestedRequestId) {
        if (MUTATION_OPERATIONS.has(operation) && payload.confirm !== true) {
            throw new Error(`${operation} requires confirm: true`);
        }
        const connection = this.selectConnection(requestedSessionId);
        const operationRequestId = requestId(requestedRequestId);
        const operationTimeoutMs = operation === "export_sequence"
            ? EXPORT_PLUGIN_TIMEOUT_MS
            : DEFAULT_PLUGIN_TIMEOUT_MS;
        const deadline = this.now() + operationTimeoutMs;
        const task = connection.tail.then(() => {
            const remainingMs = deadline - this.now();
            if (remainingMs <= 0)
                throw new Error(`Premiere request expired in session queue: ${operation}`);
            return operation === "export_sequence"
                ? this.exportSequenceSafely(connection, payload, deadline, operationRequestId)
                : this.dispatch(connection, operation, payload, MUTATION_OPERATIONS.has(operation) ? undefined : remainingMs, deadline, operationRequestId);
        });
        connection.tail = task.then(() => undefined, () => undefined);
        return task;
    }
    async exportSequenceSafely(connection, payload, deadline, operationRequestId) {
        const requestedOutput = String(payload.outputFile || "");
        const requestedPreset = String(payload.presetFile || "");
        if (!path.isAbsolute(requestedOutput) || !path.isAbsolute(requestedPreset))
            throw new Error("Export output and preset paths must be absolute");
        const presetFile = await realpath(requestedPreset);
        const presetInfo = await stat(presetFile);
        if (!presetInfo.isFile() ||
            path.extname(presetFile).toLowerCase() !== ".epr") {
            throw new Error("Export preset must resolve to a regular .epr file");
        }
        const outputDirectory = await realpath(path.dirname(requestedOutput));
        const directoryInfo = await stat(outputDirectory);
        if (!directoryInfo.isDirectory())
            throw new Error("Export output parent must be a directory");
        const outputFile = path.join(outputDirectory, path.basename(requestedOutput));
        try {
            await lstat(outputFile);
            throw new Error(`Export output already exists: ${outputFile}`);
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
        }
        const extension = path.extname(outputFile);
        if (!extension)
            throw new Error("Export output must have an extension");
        const base = path.basename(outputFile, extension);
        const stagingFile = path.join(outputDirectory, `.${base}.gateway-for-premiere-${randomUUID()}${extension}`);
        const remainingMs = deadline - this.now();
        if (remainingMs <= 0)
            throw new Error("Premiere request expired before export dispatch");
        const result = await this.dispatch(connection, "export_sequence", {
            ...payload,
            outputFile: stagingFile,
            presetFile,
        }, undefined, deadline, operationRequestId);
        const stagingInfo = await stat(stagingFile);
        if (!stagingInfo.isFile() || stagingInfo.size === 0)
            throw new Error(`Premiere did not create a valid export: ${stagingFile}`);
        try {
            await finalizeExportFile(stagingFile, outputFile);
        }
        catch (error) {
            throw new Error(`Could not finalize export without overwriting; staged file kept at ${stagingFile}: ${error instanceof Error ? error.message : String(error)}`);
        }
        await unlink(stagingFile);
        return result && typeof result === "object"
            ? { ...result, outputFile, presetFile }
            : { exported: true, outputFile, presetFile };
    }
    dispatch(connection, operation, payload, timeoutMs, deadlineEpochMs, operationRequestId) {
        if (connection.socket.readyState !== WebSocket.OPEN) {
            return Promise.reject(new Error("Premiere Plugin connection is not open"));
        }
        const id = randomUUID();
        return new Promise((resolve, reject) => {
            const rejectSend = (error) => {
                const pending = this.pending.get(id);
                if (!pending)
                    return;
                clearTimeout(pending.timer);
                this.pending.delete(id);
                reject(error);
            };
            const timer = timeoutMs
                ? setTimeout(() => {
                    this.pending.delete(id);
                    reject(new Error(`Premiere Plugin request timed out: ${operation}`));
                }, timeoutMs)
                : undefined;
            this.pending.set(id, {
                resolve,
                reject,
                timer,
                socket: connection.socket,
            });
            try {
                connection.socket.send(JSON.stringify({
                    type: "request",
                    id,
                    operation,
                    payload,
                    deadlineEpochMs,
                    requestId: operationRequestId,
                }), (error) => {
                    if (error) {
                        rejectSend(new Error(`Could not send request to Premiere Plugin: ${error.message}`));
                    }
                });
            }
            catch (error) {
                rejectSend(new Error(`Could not send request to Premiere Plugin: ${error instanceof Error ? error.message : String(error)}`));
            }
        });
    }
    selectConnection(requestedSessionId) {
        if (requestedSessionId) {
            const connection = this.connections.get(requestedSessionId);
            if (!connection)
                throw new Error(`No connected Premiere session: ${requestedSessionId}`);
            return connection;
        }
        const connections = [...this.connections.values()];
        if (connections.length === 0)
            throw new Error("No connected Premiere Plugin");
        if (connections.length > 1)
            throw new Error("Multiple Premiere sessions are connected; pass --session");
        return connections[0];
    }
    acceptPlugin(socket) {
        let sessionId = "";
        socket.on("message", (data) => {
            try {
                const message = JSON.parse(data.toString());
                if (message.type === "hello") {
                    if (!authorized(message.token || "", this.protocolToken)) {
                        socket.close(1008, "Invalid gateway protocol token");
                        return;
                    }
                    sessionId = message.session.sessionId;
                    if (!sessionId)
                        throw new Error("Plugin hello is missing sessionId");
                    const previous = this.connections.get(sessionId);
                    if (previous && previous.socket !== socket)
                        previous.socket.close();
                    this.connections.set(sessionId, {
                        session: message.session,
                        socket,
                        tail: Promise.resolve(),
                    });
                    socket.send(JSON.stringify({ type: "connected" }));
                    return;
                }
                if (message.type === "session_updated" && sessionId) {
                    if (message.session.sessionId !== sessionId)
                        throw new Error("Session identity changed");
                    const connection = this.connections.get(sessionId);
                    if (!connection || connection.socket !== socket)
                        throw new Error("Plugin session is not connected");
                    connection.session = message.session;
                    return;
                }
                if (message.type === "response") {
                    const pending = this.pending.get(message.id);
                    if (!sessionId || !pending || pending.socket !== socket)
                        return;
                    clearTimeout(pending.timer);
                    this.pending.delete(message.id);
                    if (message.ok)
                        pending.resolve(message.result);
                    else
                        pending.reject(new Error(message.error || "Premiere Plugin request failed"));
                }
            }
            catch (error) {
                socket.close(1003, error instanceof Error
                    ? error.message.slice(0, 120)
                    : "Invalid message");
            }
        });
        socket.on("close", () => {
            if (sessionId && this.connections.get(sessionId)?.socket === socket) {
                this.connections.delete(sessionId);
            }
            for (const [id, pending] of this.pending) {
                if (pending.socket !== socket)
                    continue;
                clearTimeout(pending.timer);
                this.pending.delete(id);
                pending.reject(new Error("Premiere Plugin disconnected"));
            }
        });
    }
}
