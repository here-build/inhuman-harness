/**
 * MCP persist. Session remember is `SessionRoot.toolAllowlist` /
 * `toolBlocklist` (`connection:tool` → `session` | `always`). Disk
 * Always-read is connection `alwaysAllow` via kernel
 * `connect/always-allow`. Disk forever-deny is connection `tools`
 * `!name` via kernel `connect/exclude-tool`. A grant is not a
 * license without the read floor. Blocklist is hide + deny, not a
 * silent ask→deny.
 */
import {
  mcpReadFloorAllows,
  mcpToolListHas,
  mcpToolRefKey,
  parseMcpPersistScope,
  parseMcpToolRefKey,
} from "@inhuman.tools/harness-model";
import type { ConnectionSpec } from "@inhuman.tools/plexus-expectations";

import { isMcpDriver } from "./config.js";
import { readField } from "./json.js";
import { parseMcpToolRules } from "./tool-filter.js";

/** Kernel config slice this package mutates. Product catalog shape stays in composition. */
export type McpPersistedConnection = {
  settings: Record<string, unknown>;
};

export type McpPersistedConfig = {
  connections: Record<string, McpPersistedConnection | undefined>;
};

export function alwaysAllowOf(settings: unknown): readonly string[] {
  if (settings == null || typeof settings !== "object") return [];
  return parseAlwaysAllow(readField(settings, "alwaysAllow"));
}

export function parseAlwaysAllow(raw: unknown): readonly string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((row): row is string => typeof row === "string" && row.trim() !== "");
}

export function mcpSessionPersistAllows(
  connectionKey: string,
  serverToolName: string,
  allowlist: Readonly<Record<string, string>>,
  blocklist: Readonly<Record<string, string>> = {},
): boolean {
  if (mcpToolListHas(blocklist, connectionKey, serverToolName)) return false;
  if (!mcpReadFloorAllows(serverToolName)) return false;
  return parseMcpPersistScope(allowlist[mcpToolRefKey(connectionKey, serverToolName)]) !== undefined;
}

export function mcpSessionPersistDenies(
  connectionKey: string,
  serverToolName: string,
  blocklist: Readonly<Record<string, string>>,
): boolean {
  return mcpToolListHas(blocklist, connectionKey, serverToolName);
}

export function hydrateMcpAlwaysAllows(
  allowlist: Record<string, string>,
  connections: Readonly<Record<string, ConnectionSpec | undefined>>,
): void {
  for (const [id, spec] of Object.entries(connections)) {
    if (spec == null || !isMcpDriver(spec.driver.abilityClaim)) continue;
    for (const name of alwaysAllowOf(spec.configuration)) {
      const key = mcpToolRefKey(id, name);
      if ((allowlist[key] ?? "") === "") allowlist[key] = "always";
    }
  }
}

export function mcpAlwaysRowsFromList(
  list: Readonly<Record<string, string>>,
): readonly { connectionKey: string; serverToolName: string }[] {
  const out: { connectionKey: string; serverToolName: string }[] = [];
  for (const [key, value] of Object.entries(list)) {
    if (value !== "always") continue;
    const row = parseMcpToolRefKey(key);
    if (row !== undefined) out.push(row);
  }
  return out;
}

export function addConnectionAlwaysAllow(
  config: McpPersistedConfig,
  connectionKey: string,
  serverToolName: string,
): void {
  const conn = config.connections[connectionKey];
  if (conn === undefined) return;
  const existing = parseAlwaysAllow(conn.settings.alwaysAllow);
  if (existing.includes(serverToolName)) return;
  conn.settings.alwaysAllow = [...existing, serverToolName];
}

/** Append `!serverToolName` to connection `tools`. Only-excludes imply `*`. */
export function addConnectionToolExclude(
  config: McpPersistedConfig,
  connectionKey: string,
  serverToolName: string,
): void {
  const conn = config.connections[connectionKey];
  if (conn === undefined) return;
  const existing = parseMcpToolRules(conn.settings.tools) ?? [];
  const exclude = `!${serverToolName}`;
  if (existing.some((row) => row.trim() === exclude)) return;
  conn.settings.tools = [...existing, exclude];
}
