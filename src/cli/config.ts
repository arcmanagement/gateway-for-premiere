import { readFileSync } from "node:fs";

export const DEFAULT_PORT = 1966;

const packageJson = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { gatewayForPremiere?: { protocolToken?: unknown } };
const configuredToken = packageJson.gatewayForPremiere?.protocolToken;
if (configuredToken !== "gateway-for-premiere") {
  throw new Error(
    "package.json must define protocolToken: gateway-for-premiere",
  );
}
export const GATEWAY_PROTOCOL_TOKEN = configuredToken;

export interface GlobalOptions {
  port?: string;
}

export function resolvePort(
  value = process.env.GATEWAY_FOR_PREMIERE_PORT,
): number {
  const port = Number(value || DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid GATEWAY_FOR_PREMIERE_PORT: ${value || ""}`);
  }
  return port;
}
