#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { URL } from "node:url";

const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
for (const dependency of ["ws"]) {
  if (!packageJson.dependencies?.[dependency]) {
    throw new Error(`Runtime dependency is misclassified: ${dependency}`);
  }
}
if (!packageJson.devDependencies?.esbuild) {
  throw new Error(
    "Plugin build dependency esbuild must remain development-only",
  );
}

const result = spawnSync("npm", ["pack", "--dry-run", "--json"], {
  encoding: "utf8",
});
if (result.status !== 0) {
  throw new Error((result.stderr || result.stdout || "npm pack failed").trim());
}

const packs = JSON.parse(result.stdout);
const files = new Set(packs[0]?.files?.map((file) => file.path) || []);
const required = [
  "dist/cli/doctor.js",
  "dist/cli/index.js",
  "installer/gateway-for-premiere",
  "installer/scripts/postinstall",
  "installer/scripts/preinstall",
  "installer/windows/GatewayForPremiere.iss",
  "installer/windows/gateway-for-premiere.cmd",
  "plugin/manifest.template.json",
  "plugin/src/component-param-boundary.ts",
  "plugin/src/component-param-snapshot.ts",
  "plugin/src/effect-boundary.ts",
  "plugin/src/editing-snapshot-stability.ts",
  "plugin/src/index.html",
  "plugin/src/index.ts",
  "plugin/src/json-value.ts",
  "plugin/src/mogrt-mutation.ts",
  "plugin/src/project-item-delta.ts",
  "plugin/src/project-items-projection.ts",
  "plugin/src/request-journal.ts",
  "plugin/src/timeline-stability.ts",
  "plugin/src/timeline-reliability.ts",
  "plugin/src/track-snapshot.ts",
  "scripts/build-plugin.mjs",
  "scripts/build-macos-installer.mjs",
  "scripts/build-windows-installer.mjs",
  "scripts/plugin-manifest.mjs",
  "scripts/verify-ccx.mjs",
  "scripts/verify-macos-installer.mjs",
  "scripts/verify-windows-installer.mjs",
];
for (const file of required) {
  if (!files.has(file)) throw new Error(`npm package is missing: ${file}`);
}

const forbidden = [...files].filter(
  (file) =>
    file.startsWith("plugin/dist/") ||
    file.startsWith("plugin/marketplace-dist/") ||
    file.startsWith("dist/src/") ||
    file === ".env" ||
    file.startsWith(".env."),
);
if (forbidden.length > 0) {
  throw new Error(
    `npm package contains local artifacts: ${forbidden.join(", ")}`,
  );
}

process.stdout.write(`Verified npm package contents (${files.size} files)\n`);
