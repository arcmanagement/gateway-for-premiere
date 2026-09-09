#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { access, readFile, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const packageJson = JSON.parse(
  await readFile(path.join(root, "package.json"), "utf8"),
);
const requireSigned = process.argv.includes("--require-signed");
const explicitPackagePath = process.argv
  .slice(2)
  .find((value) => !value.startsWith("--"));
const packagePath =
  explicitPackagePath ||
  path.join(
    root,
    "release",
    `Gateway-for-Premiere-${packageJson.version}-macOS-universal.pkg`,
  );
const expandDir = path.join(root, ".tmp", "verify-macos-installer");

function run(command, args, allowFailure = false) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (!allowFailure && (result.error || result.status !== 0)) {
    throw new Error(
      `${command} ${args.join(" ")} failed: ${String(result.stderr || result.stdout || result.error?.message || "").trim()}`,
    );
  }
  return String(result.stdout || result.stderr || "");
}

if (process.platform !== "darwin")
  throw new Error("The macOS installer must be verified on macOS");
await access(packagePath);
const signature = run("pkgutil", ["--check-signature", packagePath], true);
const signed = !signature.includes("Status: no signature");
if (requireSigned && !signed)
  throw new Error("Release installer is not signed");
if (requireSigned) {
  run("xcrun", ["stapler", "validate", packagePath]);
  run("spctl", ["--assess", "--type", "install", "--verbose=4", packagePath]);
}
await rm(expandDir, { recursive: true, force: true });
run("pkgutil", ["--expand-full", packagePath, expandDir]);

const rootDir = path.join(expandDir, "Payload");
for (const required of [
  "usr/local/bin/gateway-for-premiere",
  "usr/local/lib/gateway-for-premiere/dist/cli/index.js",
  "usr/local/lib/gateway-for-premiere/node_modules/ws/package.json",
  "usr/local/lib/gateway-for-premiere/runtime/arm64/bin/node",
  "usr/local/lib/gateway-for-premiere/runtime/x64/bin/node",
]) {
  await access(path.join(rootDir, required));
}
const armArchitectures = run("lipo", [
  "-archs",
  path.join(
    rootDir,
    "usr/local/lib/gateway-for-premiere/runtime/arm64/bin/node",
  ),
]);
const x64Architectures = run("lipo", [
  "-archs",
  path.join(rootDir, "usr/local/lib/gateway-for-premiere/runtime/x64/bin/node"),
]);
if (!armArchitectures.split(/\s+/).includes("arm64"))
  throw new Error("Installer arm64 Node runtime is invalid");
if (!x64Architectures.split(/\s+/).includes("x86_64"))
  throw new Error("Installer x64 Node runtime is invalid");

const currentArchitecture = process.arch === "arm64" ? "arm64" : "x64";
const nodePath = path.join(
  rootDir,
  `usr/local/lib/gateway-for-premiere/runtime/${currentArchitecture}/bin/node`,
);
const entrypoint = path.join(
  rootDir,
  "usr/local/lib/gateway-for-premiere/dist/cli/index.js",
);
const help = run(nodePath, [entrypoint, "--help"]);
if (!help.includes("gateway-for-premiere daemon install"))
  throw new Error("Packaged CLI did not start");

await rm(expandDir, { recursive: true, force: true });
process.stdout.write(
  `Verified ${path.basename(packagePath)} (${signed ? "signed" : "unsigned"}, arm64 + x86_64)\n`,
);
