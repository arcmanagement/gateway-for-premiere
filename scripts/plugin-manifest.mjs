export const PLUGIN_MODES = ["panel", "invisible"];
export const PLUGIN_DISTRIBUTIONS = ["development", "marketplace"];

const PLUGIN_IDS = Object.freeze({
  development: "com.arcmanagement.premiere-gateway",
  marketplace: "ac804039",
});

export function renderPluginManifest(template, options) {
  const { mode, pluginVersion, port, distribution = "development" } = options;
  if (!PLUGIN_MODES.includes(mode)) {
    throw new Error(`Invalid Plugin mode: ${String(mode)}`);
  }
  if (!PLUGIN_DISTRIBUTIONS.includes(distribution)) {
    throw new Error(`Invalid Plugin distribution: ${String(distribution)}`);
  }

  const manifest = JSON.parse(
    template
      .replaceAll("__PLUGIN_ID__", PLUGIN_IDS[distribution])
      .replaceAll("__PLUGIN_VERSION__", pluginVersion)
      .replaceAll("__GATEWAY_PORT__", String(port)),
  );
  if (mode === "invisible") {
    manifest.hostUIContext = { hideFromMenu: true };
  }
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
