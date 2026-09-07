#!/usr/bin/env node
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

const defaultCcxUrl = new URL(
  "../plugin/marketplace-dist/ac804039_premierepro.ccx",
  import.meta.url,
);
const ccxPath = process.argv[2] || fileURLToPath(defaultCcxUrl);
const sourceUrls = {
  "manifest.json": new URL(
    "../plugin/marketplace-dist/manifest.json",
    import.meta.url,
  ),
  "index.html": new URL(
    "../plugin/marketplace-dist/index.html",
    import.meta.url,
  ),
  "index.js": new URL("../plugin/marketplace-dist/index.js", import.meta.url),
};
const expectedEntries = Object.keys(sourceUrls).sort();
const maximumSize = 50 * 1024 * 1024;

function unzip(args, encoding = null) {
  const result = spawnSync("unzip", args, {
    encoding,
    maxBuffer: maximumSize + 1024 * 1024,
  });
  if (result.status !== 0) {
    const message = Buffer.isBuffer(result.stderr)
      ? result.stderr.toString("utf8")
      : result.stderr;
    throw new Error((message || `unzip ${args.join(" ")} failed`).trim());
  }
  return result.stdout;
}

const archiveStat = await stat(ccxPath);
assert.ok(archiveStat.isFile(), `CCX is not a file: ${ccxPath}`);
assert.ok(
  archiveStat.size < maximumSize,
  `CCX exceeds Adobe's 50 MB limit: ${archiveStat.size} bytes`,
);

unzip(["-t", ccxPath], "utf8");
const entries = String(unzip(["-Z1", ccxPath], "utf8"))
  .split("\n")
  .map((entry) => entry.trim())
  .filter(Boolean)
  .sort();
assert.deepEqual(entries, expectedEntries, "CCX contains unexpected files");

const archiveManifest = JSON.parse(
  unzip(["-p", ccxPath, "manifest.json"]).toString("utf8"),
);
const sourceManifest = JSON.parse(
  await readFile(sourceUrls["manifest.json"], "utf8"),
);
assert.deepEqual(
  archiveManifest,
  sourceManifest,
  "CCX manifest differs from marketplace-dist",
);
assert.equal(archiveManifest.id, "ac804039");
assert.equal(archiveManifest.host?.app, "premierepro");
assert.equal(archiveManifest.hostUIContext?.hideFromMenu, true);

for (const filename of ["index.html", "index.js"]) {
  const archived = unzip(["-p", ccxPath, filename]);
  const source = await readFile(sourceUrls[filename]);
  assert.ok(
    archived.equals(source),
    `CCX ${filename} differs from marketplace-dist`,
  );
}

const bundle = unzip(["-p", ccxPath, "index.js"]).toString("utf8");
assert.match(bundle, /["']gateway-for-premiere["']/);
assert.doesNotMatch(
  bundle,
  /GATEWAY_FOR_PREMIERE_SECRET|x-gateway-for-premiere-secret|Keychain/,
);

const digest = createHash("sha256")
  .update(await readFile(ccxPath))
  .digest("hex");
process.stdout.write(
  `Verified UDT CCX ${ccxPath} (${archiveStat.size} bytes, sha256 ${digest})\n`,
);
