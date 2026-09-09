#!/usr/bin/env node
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const packageJson = JSON.parse(
  await readFile(path.join(root, "package.json"), "utf8"),
);
const nodeVersion = process.env.GATEWAY_INSTALLER_NODE_VERSION || "22.23.2";
const outputDir = path.join(root, "release");
const workDir = path.join(root, ".tmp", "windows-installer");
const cacheDir = path.join(root, ".tmp", "node-runtime-cache");
const stageDir = path.join(workDir, "stage");
const appDir = path.join(stageDir, "app");
const outputPath = path.join(
  outputDir,
  `Gateway-for-Premiere-${packageJson.version}-Windows.exe`,
);
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

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
  const response = await globalThis.fetch(url);
  if (!response.ok)
    throw new Error(`Download failed (${response.status}): ${url}`);
  await writeFile(destination, Buffer.from(await response.arrayBuffer()));
}

async function sha256(filePath) {
  return createHash("sha256")
    .update(await readFile(filePath))
    .digest("hex");
}

async function installNodeRuntime(architecture, checksums) {
  const archiveName = `node-v${nodeVersion}-win-${architecture}.zip`;
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
  if ((await sha256(archivePath)) !== expected)
    throw new Error(`Node checksum mismatch for ${archiveName}`);

  const extractDir = path.join(workDir, `node-${architecture}`);
  await mkdir(extractDir, { recursive: true });
  run("tar", ["-xf", archivePath, "-C", extractDir]);
  const sourceRoot = path.join(
    extractDir,
    `node-v${nodeVersion}-win-${architecture}`,
  );
  const destination = path.join(stageDir, "runtime", architecture);
  await mkdir(destination, { recursive: true });
  await copyFile(
    path.join(sourceRoot, "node.exe"),
    path.join(destination, "node.exe"),
  );
  await copyFile(
    path.join(sourceRoot, "LICENSE"),
    path.join(destination, "LICENSE.node.txt"),
  );
}

await rm(workDir, { recursive: true, force: true });
await mkdir(appDir, { recursive: true });
await mkdir(outputDir, { recursive: true });

run(npmCommand, ["run", "build:server"]);
const packed = JSON.parse(
  run(npmCommand, ["pack", "--pack-destination", workDir, "--json"], {
    capture: true,
  }),
);
run("tar", [
  "-xzf",
  path.join(workDir, packed[0].filename),
  "-C",
  appDir,
  "--strip-components=1",
]);
run(npmCommand, [
  "install",
  "--omit=dev",
  "--ignore-scripts",
  "--no-audit",
  "--no-fund",
  "--prefix",
  appDir,
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
await installNodeRuntime("x64", checksums);
await installNodeRuntime("arm64", checksums);
await mkdir(path.join(stageDir, "bin"), { recursive: true });
await copyFile(
  path.join(root, "installer", "windows", "gateway-for-premiere.cmd"),
  path.join(stageDir, "bin", "gateway-for-premiere.cmd"),
);
await cp(
  path.join(root, "installer", "windows", "GatewayForPremiere.iss"),
  path.join(workDir, "GatewayForPremiere.iss"),
);

if (process.argv.includes("--stage-only")) {
  process.stdout.write(`${stageDir}\n`);
  process.exit(0);
}

const isccCandidates = [
  process.env.ISCC_PATH,
  process.platform === "win32"
    ? path.join(
        process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
        "Inno Setup 6",
        "ISCC.exe",
      )
    : undefined,
  process.platform === "win32" && process.env.LOCALAPPDATA
    ? path.join(
        process.env.LOCALAPPDATA,
        "Programs",
        "Inno Setup 6",
        "ISCC.exe",
      )
    : undefined,
  process.platform !== "win32" ? "iscc" : undefined,
].filter(Boolean);
const iscc = isccCandidates.find(
  (candidate) => candidate === "iscc" || existsSync(candidate),
);
if (!iscc)
  throw new Error(
    "Inno Setup 6 was not found; set ISCC_PATH or use --stage-only",
  );
run(iscc, [
  `/DMyAppVersion=${packageJson.version}`,
  `/DStageDir=${stageDir}`,
  `/DOutputDir=${outputDir}`,
  path.join(workDir, "GatewayForPremiere.iss"),
]);

await writeFile(
  `${outputPath}.sha256`,
  `${await sha256(outputPath)}  ${path.basename(outputPath)}\n`,
  "utf8",
);
process.stdout.write(`${outputPath}\n`);
