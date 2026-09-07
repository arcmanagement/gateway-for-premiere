import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { finalizeExportFile, GatewayServer } from "../src/server/gateway.js";
import {
  DEFAULT_PLUGIN_TIMEOUT_MS,
  type PluginRequest,
} from "../src/shared/protocol.js";

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Could not reserve a test port");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function connectPlugin(
  port: number,
  token: string,
  sessionId = "session-1",
): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/plugin`, {
    origin: "file://",
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  socket.send(
    JSON.stringify({
      type: "hello",
      token,
      session: {
        sessionId,
        pluginVersion: "test",
        premiereVersion: "26.3.2",
        projectGuid: "project-1",
        sequenceGuid: "sequence-1",
      },
    }),
  );
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Plugin connection timed out")),
      1000,
    );
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as { type?: string };
      if (message.type === "connected") {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  return socket;
}

test("health requires the fixed protocol token header", async (context) => {
  const port = await freePort();
  const gateway = new GatewayServer(port, "test-token");
  await gateway.start();
  context.after(() => gateway.close());

  const unauthorized = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(unauthorized.status, 401);

  const authorized = await fetch(`http://127.0.0.1:${port}/health`, {
    headers: { "x-gateway-for-premiere-token": "test-token" },
  });
  assert.equal(authorized.status, 200);
  assert.deepEqual(await authorized.json(), { ok: true, sessions: [] });
});

test("browser origins cannot register a fake Plugin session", async (context) => {
  const port = await freePort();
  const gateway = new GatewayServer(port, "test-token");
  await gateway.start();
  context.after(() => gateway.close());

  const socket = new WebSocket(`ws://127.0.0.1:${port}/plugin`, {
    origin: "https://evil.example",
  });
  await new Promise<void>((resolve) => {
    socket.once("error", () => resolve());
    socket.once("close", () => resolve());
  });

  assert.deepEqual(gateway.listSessions(), []);
});

test("read operations are routed to the origin-and-token-gated Plugin", async (context) => {
  const port = await freePort();
  const gateway = new GatewayServer(port, "test-token");
  await gateway.start();
  const socket = await connectPlugin(port, "test-token");
  context.after(async () => {
    socket.close();
    await gateway.close();
  });

  socket.on("message", (data) => {
    const message = JSON.parse(data.toString()) as
      PluginRequest | { type?: string };
    if (message.type !== "request") return;
    socket.send(
      JSON.stringify({
        type: "response",
        id: message.id,
        ok: true,
        result: { guid: "project-1", name: "Example" },
      }),
    );
  });

  const result = await gateway.call("get_active_project", {});
  assert.deepEqual(result, { guid: "project-1", name: "Example" });
});

test("mutations require explicit confirmation before reaching the Plugin", async (context) => {
  const port = await freePort();
  const gateway = new GatewayServer(port, "test-token");
  await gateway.start();
  const socket = await connectPlugin(port, "test-token");
  context.after(async () => {
    socket.close();
    await gateway.close();
  });

  await assert.rejects(
    gateway.call("trim_track_item", { expectedRevision: "abc" }),
    /requires confirm: true/,
  );
  await assert.rejects(
    gateway.call("add_video_effect", { expectedRevision: "abc" }),
    /requires confirm: true/,
  );
  await assert.rejects(
    gateway.call("export_sequence", { expectedRevision: "abc" }),
    /requires confirm: true/,
  );
});

test("one Premiere session serializes concurrent RPC requests", async (context) => {
  const port = await freePort();
  const gateway = new GatewayServer(port, "test-token");
  await gateway.start();
  const socket = await connectPlugin(port, "test-token");
  context.after(async () => {
    socket.close();
    await gateway.close();
  });

  let firstResponded = false;
  let overlapped = false;
  let count = 0;
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString()) as
      PluginRequest | { type?: string };
    if (message.type !== "request") return;
    count += 1;
    if (count === 1) {
      setTimeout(() => {
        firstResponded = true;
        socket.send(
          JSON.stringify({
            type: "response",
            id: message.id,
            ok: true,
            result: { request: 1 },
          }),
        );
      }, 20);
      return;
    }
    if (!firstResponded) overlapped = true;
    socket.send(
      JSON.stringify({
        type: "response",
        id: message.id,
        ok: true,
        result: { request: 2 },
      }),
    );
  });

  const [first, second] = await Promise.all([
    gateway.call("update_track_item", { confirm: true }),
    gateway.call("update_track_item", { confirm: true }),
  ]);
  assert.deepEqual(first, { request: 1 });
  assert.deepEqual(second, { request: 2 });
  assert.equal(overlapped, false);
});

test("a late mutation keeps the wire queue locked and an expired follower is never dispatched", async (context) => {
  let now = 1_000;
  const port = await freePort();
  const gateway = new GatewayServer(port, "test-token", () => now);
  await gateway.start();
  const socket = await connectPlugin(port, "test-token");
  context.after(async () => {
    socket.close();
    await gateway.close();
  });

  let dispatched = 0;
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString()) as
      PluginRequest | { type?: string };
    if (message.type !== "request") return;
    dispatched += 1;
    assert.equal(message.deadlineEpochMs, 1_000 + DEFAULT_PLUGIN_TIMEOUT_MS);
    now += DEFAULT_PLUGIN_TIMEOUT_MS + 1;
    setTimeout(() => {
      socket.send(
        JSON.stringify({
          type: "response",
          id: message.id,
          ok: true,
          result: { request: 1 },
        }),
      );
    }, 20);
  });

  const first = gateway.call("update_track_item", { confirm: true });
  const expired = gateway.call("update_track_item", { confirm: true });
  assert.deepEqual(await first, { request: 1 });
  await assert.rejects(expired, /expired in session queue/);
  assert.equal(dispatched, 1);
});

test("broker stages exports and finalizes without overwriting", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gateway-export-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const presetFile = path.join(directory, "preset.epr");
  const outputFile = path.join(directory, "result.mov");
  const resolvedOutput = path.join(await realpath(directory), "result.mov");
  await writeFile(presetFile, "preset");

  const port = await freePort();
  const gateway = new GatewayServer(port, "test-token");
  await gateway.start();
  const socket = await connectPlugin(port, "test-token");
  context.after(async () => {
    socket.close();
    await gateway.close();
  });
  socket.on("message", async (data) => {
    const message = JSON.parse(data.toString()) as
      PluginRequest | { type?: string };
    if (message.type !== "request") return;
    const stagingFile = String(message.payload.outputFile);
    assert.notEqual(stagingFile, outputFile);
    await writeFile(stagingFile, "rendered video");
    socket.send(
      JSON.stringify({
        type: "response",
        id: message.id,
        ok: true,
        result: { exported: true, outputFile: stagingFile },
      }),
    );
  });

  const result = (await gateway.call("export_sequence", {
    confirm: true,
    outputFile,
    presetFile,
  })) as { outputFile?: string };
  assert.equal(result.outputFile, resolvedOutput);
  assert.equal(await readFile(outputFile, "utf8"), "rendered video");
  assert.deepEqual((await readdir(directory)).sort(), [
    "preset.epr",
    "result.mov",
  ]);

  await assert.rejects(
    gateway.call("export_sequence", {
      confirm: true,
      outputFile,
      presetFile,
    }),
    /already exists/,
  );

  const presetDirectory = path.join(directory, "not-a-file.epr");
  await mkdir(presetDirectory);
  await assert.rejects(
    gateway.call("export_sequence", {
      confirm: true,
      outputFile: path.join(directory, "other.mov"),
      presetFile: presetDirectory,
    }),
    /regular \.epr file/,
  );
});

test("export finalization falls back to an exclusive copy when links are unsupported", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gateway-finalize-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const stagingFile = path.join(directory, ".staged.mov");
  const outputFile = path.join(directory, "result.mov");
  await writeFile(stagingFile, "rendered video");
  const unsupportedLink = async (): Promise<void> => {
    const error = new Error("links unsupported") as NodeJS.ErrnoException;
    error.code = "ENOTSUP";
    throw error;
  };

  await finalizeExportFile(stagingFile, outputFile, unsupportedLink);
  assert.equal(await readFile(outputFile, "utf8"), "rendered video");
  await assert.rejects(
    finalizeExportFile(stagingFile, outputFile, unsupportedLink),
    /EEXIST/,
  );
});

test("Plugin disconnect rejects an in-flight RPC immediately", async (context) => {
  const port = await freePort();
  const gateway = new GatewayServer(port, "test-token");
  await gateway.start();
  const socket = await connectPlugin(port, "test-token");
  context.after(() => gateway.close());
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString()) as { type?: string };
    if (message.type === "request") socket.close();
  });
  await assert.rejects(
    gateway.call("get_active_project", {}),
    /Plugin disconnected/,
  );
});

test("Plugin disconnect also rejects queued RPCs without dispatching them", async (context) => {
  const port = await freePort();
  const gateway = new GatewayServer(port, "test-token");
  await gateway.start();
  const socket = await connectPlugin(port, "test-token");
  context.after(() => gateway.close());
  let dispatched = 0;
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString()) as { type?: string };
    if (message.type !== "request") return;
    dispatched += 1;
    socket.close();
  });

  const inFlight = gateway.call("get_active_project", {});
  const queued = gateway.call("update_track_item", { confirm: true });
  await assert.rejects(inFlight, /Plugin disconnected/);
  await assert.rejects(queued, /connection is not open/);
  assert.equal(dispatched, 1);
});

test("multiple sessions require an explicit target", async (context) => {
  const port = await freePort();
  const gateway = new GatewayServer(port, "test-token");
  await gateway.start();
  const first = await connectPlugin(port, "test-token", "session-1");
  const second = await connectPlugin(port, "test-token", "session-2");
  context.after(async () => {
    first.close();
    second.close();
    await gateway.close();
  });

  await assert.rejects(
    gateway.call("get_active_project", {}),
    /Multiple Premiere sessions/,
  );
});
