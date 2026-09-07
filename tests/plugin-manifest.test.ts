import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { renderPluginManifest } from "../scripts/plugin-manifest.mjs";

test("the Plugin can only connect to the fixed localhost broker origin", async () => {
  const manifest = JSON.parse(
    await readFile(
      new URL("../plugin/manifest.template.json", import.meta.url),
      "utf8",
    ),
  ) as {
    requiredPermissions?: { network?: { domains?: unknown } };
  };

  assert.deepEqual(manifest.requiredPermissions?.network?.domains, [
    "ws://localhost:__GATEWAY_PORT__",
  ]);
  assert.equal(manifest.id, "__PLUGIN_ID__");
});

test("the local Plugin artifact is excluded from npm packages", async () => {
  const npmIgnore = await readFile(
    new URL("../.npmignore", import.meta.url),
    "utf8",
  );
  assert.match(npmIgnore, /^plugin\/dist\/$/m);
  assert.match(npmIgnore, /^plugin\/marketplace-dist\/$/m);
  assert.doesNotMatch(npmIgnore, /^plugin\/src\/$/m);
});

test("invisible builds use Adobe's application-launch manifest flag only when requested", async () => {
  const template = await readFile(
    new URL("../plugin/manifest.template.json", import.meta.url),
    "utf8",
  );
  const panel = JSON.parse(
    renderPluginManifest(template, {
      mode: "panel",
      pluginVersion: "1.2.3",
      port: 1966,
    }),
  );
  const invisible = JSON.parse(
    renderPluginManifest(template, {
      mode: "invisible",
      pluginVersion: "1.2.3",
      port: 1966,
    }),
  );

  assert.equal(panel.hostUIContext, undefined);
  assert.deepEqual(invisible.hostUIContext, { hideFromMenu: true });
  assert.deepEqual(panel.entrypoints, invisible.entrypoints);
  assert.deepEqual(panel.requiredPermissions, invisible.requiredPermissions);
});

test("development and Marketplace builds use only their fixed Adobe Plugin IDs", async () => {
  const template = await readFile(
    new URL("../plugin/manifest.template.json", import.meta.url),
    "utf8",
  );
  const development = JSON.parse(
    renderPluginManifest(template, {
      mode: "panel",
      pluginVersion: "1.2.3",
      port: 1966,
      distribution: "development",
    }),
  );
  const marketplace = JSON.parse(
    renderPluginManifest(template, {
      mode: "invisible",
      pluginVersion: "1.2.3",
      port: 1966,
      distribution: "marketplace",
    }),
  );

  assert.equal(development.id, "com.arcmanagement.gateway-for-premiere");
  assert.equal(marketplace.id, "ac804039");
  assert.throws(
    () =>
      renderPluginManifest(template, {
        mode: "panel",
        pluginVersion: "1.2.3",
        port: 1966,
        distribution: "custom",
      }),
    /Invalid Plugin distribution/,
  );
});
