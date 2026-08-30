import { readFileSync } from "node:fs";

export const DEFAULT_PORT = 1966;

const packageJson = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { premiereGateway?: { protocolToken?: unknown } };
const configuredToken = packageJson.premiereGateway?.protocolToken;
if (configuredToken !== "premiere-gateway") {
  throw new Error("package.json must define protocolToken: premiere-gateway");
}
export const GATEWAY_PROTOCOL_TOKEN = configuredToken;

export interface GlobalOptions {
  port?: string;
}

export function resolvePort(value = process.env.PREMIERE_GATEWAY_PORT): number {
  const port = Number(value || DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PREMIERE_GATEWAY_PORT: ${value || ""}`);
  }
  return port;
}
