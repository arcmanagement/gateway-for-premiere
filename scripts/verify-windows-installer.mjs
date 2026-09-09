#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const packageJson = JSON.parse(
  await readFile(path.join(root, "package.json"), "utf8"),
);
const installerPath = path.join(
  root,
  "release",
  `Gateway-for-Premiere-${packageJson.version}-Windows.exe`,
);
if ((await stat(installerPath)).size < 10_000_000)
  throw new Error("Windows installer is unexpectedly small");

const expectedLine = (await readFile(`${installerPath}.sha256`, "utf8")).trim();
const actual = createHash("sha256")
  .update(await readFile(installerPath))
  .digest("hex");
if (expectedLine !== `${actual}  ${path.basename(installerPath)}`)
  throw new Error("Windows installer checksum does not match");

if (process.argv.includes("--require-signed")) {
  if (process.platform !== "win32")
    throw new Error("Authenticode verification must run on Windows");
  const escaped = installerPath.replaceAll("'", "''");
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      `(Get-AuthenticodeSignature -LiteralPath '${escaped}').Status`,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0 || result.stdout.trim() !== "Valid")
    throw new Error(
      `Windows installer is not Authenticode signed: ${result.stdout.trim()}`,
    );
}

process.stdout.write(`Verified Windows installer: ${installerPath}\n`);
