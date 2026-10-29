/**
 * MCP transport connection settings + secrets. Two yaml bags, two schemas.
 * Transport is the driver (`mcp-stdio` / `mcp-http`), not a setting.
 */
import { headersRecord, type HeaderInit } from "./fetch.js";

/** DriverSpec.abilityClaim. Not the driver name (`mcp-stdio` / `mcp-http`). */
export function isMcpDriver(can: readonly string[]): boolean {
  return can.includes("mcp");
}

/** Omitted `enabled` is on (`!== false`). */
export function isMcpEnabled(config: { readonly enabled?: boolean } | Record<string, unknown>): boolean {
  return config.enabled !== false;
}

/** MCP stamp. Secret Authorization wins colliding keys. Never another connection's secrets. */
export function stampBearer(
  secrets: { get(field: string): unknown },
  settingsHeaders?: Readonly<Record<string, string>>,
  init?: HeaderInit,
): Record<string, string> {
  const out: Record<string, string> = {
    ...headersRecord(init),
    ...(settingsHeaders ?? {}),
  };
  const token = secrets.get("token") ?? secrets.get("apiKey");
  if (typeof token === "string" && token !== "") {
    for (const key of Object.keys(out)) {
      if (key.toLowerCase() === "authorization") delete out[key];
    }
    out.Authorization = `Bearer ${token}`;
  }
  return out;
}
