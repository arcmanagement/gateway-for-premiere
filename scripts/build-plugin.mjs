#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { build } from "esbuild";
import {
  PLUGIN_DISTRIBUTIONS,
  PLUGIN_MODES,
  renderPluginManifest,
} from "./plugin-manifest.mjs";

const root = process.cwd();
const packageJson = JSON.parse(
  await readFile(path.join(root, "package.json"), "utf8"),
);
const port = Number(process.env.GATEWAY_FOR_PREMIERE_PORT || 1966);
const protocolToken = packageJson.gatewayForPremiere?.protocolToken;
const mode = process.env.GATEWAY_FOR_PREMIERE_PLUGIN_MODE || "panel";
const distribution =
  process.env.GATEWAY_FOR_PREMIERE_PLUGIN_DISTRIBUTION || "development";

if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error(`Invalid port: ${port}`);
if (protocolToken !== "gateway-for-premiere") {
  throw new Error(
    "package.json must define protocolToken: gateway-for-premiere",
  );
}
if (!PLUGIN_MODES.includes(mode)) {
  throw new Error(`Invalid GATEWAY_FOR_PREMIERE_PLUGIN_MODE: ${mode}`);
}
if (!PLUGIN_DISTRIBUTIONS.includes(distribution)) {
  throw new Error(
    `Invalid GATEWAY_FOR_PREMIERE_PLUGIN_DISTRIBUTION: ${distribution}`,
  );
}

const result = await build({
  entryPoints: [path.join(root, "plugin", "src", "index.ts")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  write: false,
  external: ["premierepro", "uxp"],
  define: {
    __GATEWAY_PORT__: String(port),
    __GATEWAY_TOKEN__: JSON.stringify(protocolToken),
    __PLUGIN_VERSION__: JSON.stringify(packageJson.version),
  },
});

const output = path.join(
  root,
  "plugin",
  distribution === "marketplace" ? "marketplace-dist" : "dist",
);
await mkdir(output, { recursive: true });
await writeFile(path.join(output, "index.js"), result.outputFiles[0].contents);
await writeFile(
  path.join(output, "index.html"),
  await readFile(path.join(root, "plugin", "src", "index.html")),
);
await writeFile(
  path.join(output, "manifest.json"),
  renderPluginManifest(
    await readFile(path.join(root, "plugin", "manifest.template.json"), "utf8"),
    { mode, pluginVersion: packageJson.version, port, distribution },
  ),
);
process.stdout.write(`${path.join(output, "manifest.json")}\n`);
