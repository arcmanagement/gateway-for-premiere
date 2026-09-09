#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const packageJson = JSON.parse(
  await readFile(path.join(root, "package.json"), "utf8"),
);
const nodeVersion = process.env.GATEWAY_INSTALLER_NODE_VERSION || "22.23.2";
const signingIdentity = process.env.MACOS_INSTALLER_SIGNING_IDENTITY || "";
const notaryProfile = process.env.MACOS_NOTARY_PROFILE || "";
const outputDir = path.join(root, "release");
const workDir = path.join(root, ".tmp", "macos-installer");
const cacheDir = path.join(root, ".tmp", "node-runtime-cache");
const payloadDir = path.join(workDir, "payload");
const scriptsDir = path.join(workDir, "scripts");
const installRoot = path.join(
  payloadDir,
  "usr",
  "local",
  "lib",
  "gateway-for-premiere",
);
const outputPath = path.join(
  outputDir,
  `Gateway-for-Premiere-${packageJson.version}-macOS-universal.pkg`,
);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.error || result.status !== 0) {
    const detail = String(
      result.stderr || result.stdout || result.error?.message || "",
    ).trim();
    throw new Error(
      `${command} ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`,
    );
  }
  return String(result.stdout || "");
}

async function download(url, destination) {
  await mkdir(path.dirname(destination), { recursive: true });
  run("curl", [
    "--fail",
    "--location",
    "--retry",
    "3",
    "--output",
    destination,
    url,
  ]);
}

async function sha256(filePath) {
  return createHash("sha256")
    .update(await readFile(filePath))
    .digest("hex");
}

async function installNodeRuntime(
  architecture,
  archiveArchitecture,
  checksums,
) {
  const archiveName = `node-v${nodeVersion}-darwin-${archiveArchitecture}.tar.gz`;
  const expected = checksums.match(
    new RegExp(`^([a-f0-9]{64})  ${archiveName}$`, "m"),
  )?.[1];
  if (!expected) throw new Error(`Node checksum is missing for ${archiveName}`);

  const archivePath = path.join(cacheDir, archiveName);
  try {
    if ((await sha256(archivePath)) !== expected)
      throw new Error("checksum mismatch");
  } catch {
    await download(
      `https://nodejs.org/dist/v${nodeVersion}/${archiveName}`,
      archivePath,
    );
  }
  const actual = await sha256(archivePath);
  if (actual !== expected)
    throw new Error(`Node checksum mismatch for ${archiveName}`);

  const extractDir = path.join(workDir, `node-${architecture}`);
  await mkdir(extractDir, { recursive: true });
  run("tar", ["-xzf", archivePath, "-C", extractDir]);
  const sourceRoot = path.join(
    extractDir,
    `node-v${nodeVersion}-darwin-${archiveArchitecture}`,
  );
  const destination = path.join(installRoot, "runtime", architecture);
  await mkdir(path.join(destination, "bin"), { recursive: true });
  await copyFile(
    path.join(sourceRoot, "bin", "node"),
    path.join(destination, "bin", "node"),
  );
  await chmod(path.join(destination, "bin", "node"), 0o755);
  await copyFile(
    path.join(sourceRoot, "LICENSE"),
    path.join(destination, "LICENSE.node.txt"),
  );
}

if (process.platform !== "darwin")
  throw new Error("The macOS installer must be built on macOS");
await rm(workDir, { recursive: true, force: true });
await mkdir(installRoot, { recursive: true });
await mkdir(outputDir, { recursive: true });

run("npm", ["run", "build:server"]);
const packedName = run(
  "npm",
  ["pack", "--pack-destination", workDir, "--json"],
  { capture: true },
);
const packed = JSON.parse(packedName);
const archivePath = path.join(workDir, packed[0].filename);
run("tar", ["-xzf", archivePath, "-C", installRoot, "--strip-components=1"]);
run("npm", [
  "install",
  "--omit=dev",
  "--ignore-scripts",
  "--no-audit",
  "--no-fund",
  "--prefix",
  installRoot,
]);

const checksumsPath = path.join(cacheDir, `SHASUMS256-v${nodeVersion}.txt`);
try {
  await readFile(checksumsPath, "utf8");
} catch {
  await download(
    `https://nodejs.org/dist/v${nodeVersion}/SHASUMS256.txt`,
    checksumsPath,
  );
}
const checksums = await readFile(checksumsPath, "utf8");
await installNodeRuntime("arm64", "arm64", checksums);
await installNodeRuntime("x64", "x64", checksums);

const commandDir = path.join(payloadDir, "usr", "local", "bin");
await mkdir(commandDir, { recursive: true });
await copyFile(
  path.join(root, "installer", "gateway-for-premiere"),
  path.join(commandDir, "gateway-for-premiere"),
);
await chmod(path.join(commandDir, "gateway-for-premiere"), 0o755);
await cp(path.join(root, "installer", "scripts"), scriptsDir, {
  recursive: true,
});
await chmod(path.join(scriptsDir, "preinstall"), 0o755);
await chmod(path.join(scriptsDir, "postinstall"), 0o755);

const args = [
  "--root",
  payloadDir,
  "--scripts",
  scriptsDir,
  "--identifier",
  "com.arcmanagement.gateway-for-premiere",
  "--version",
  packageJson.version,
  "--install-location",
  "/",
];
if (signingIdentity) args.push("--sign", signingIdentity);
args.push(outputPath);
run("pkgbuild", args);

if (notaryProfile) {
  if (!signingIdentity)
    throw new Error(
      "MACOS_NOTARY_PROFILE requires MACOS_INSTALLER_SIGNING_IDENTITY",
    );
  run("xcrun", [
    "notarytool",
    "submit",
    outputPath,
    "--keychain-profile",
    notaryProfile,
    "--wait",
  ]);
  run("xcrun", ["stapler", "staple", outputPath]);
  run("xcrun", ["stapler", "validate", outputPath]);
  run("spctl", ["--assess", "--type", "install", "--verbose=4", outputPath]);
}

await writeFile(
  `${outputPath}.sha256`,
  `${await sha256(outputPath)}  ${path.basename(outputPath)}\n`,
  "utf8",
);
process.stdout.write(`${outputPath}\n`);
