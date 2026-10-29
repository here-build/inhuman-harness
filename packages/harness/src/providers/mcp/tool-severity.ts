/**
 * Per-server `toolSeverity` overlay on the connection settings bag.
 * Auto-classify (name prefix today) covers the base cases. This map is
 * the named leftover — last matching key wins. Keys are `serverToolName`
 * globs. Missing / malformed = no overlay.
 *
 * Catalog class mapping: view → read, effect → effect, irreversible-effect → write.
 * Auto-classify today is only read|write from a name prefix; `effect` is
 * overlay-only. Classifier / persist must not treat an overlay as a grant.
 */
import { mcpGlobMatch } from "./tool-filter.js";

export const MCP_TOOL_SEVERITIES = ["view", "effect", "irreversible-effect"] as const;
export type McpToolSeverity = (typeof MCP_TOOL_SEVERITIES)[number];

const SEVERITY = new Set<string>(MCP_TOOL_SEVERITIES);

const CATALOG_CLASS: Record<McpToolSeverity, string> = {
  view: "read",
  effect: "effect",
  "irreversible-effect": "write",
};

export function parseMcpToolSeverity(raw: unknown): McpToolSeverity | undefined {
  return typeof raw === "string" && SEVERITY.has(raw) ? (raw as McpToolSeverity) : undefined;
}

export function mcpToolSeverityOf(raw: unknown, serverToolName: string): McpToolSeverity | undefined {
  if (raw === undefined || raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  let hit: McpToolSeverity | undefined;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const pattern = key.trim();
    if (pattern === "" || !mcpGlobMatch(pattern, serverToolName)) continue;
    const severity = parseMcpToolSeverity(value);
    if (severity !== undefined) hit = severity;
  }
  return hit;
}

export function mcpCatalogClassOf(serverToolName: string, autoClass: string | undefined, raw: unknown): string {
  const overlay = mcpToolSeverityOf(raw, serverToolName);
  if (overlay !== undefined) return CATALOG_CLASS[overlay];
  return autoClass ?? "effect";
}

export function mcpToolSeveritySettingOf(
  settings: { readonly toolSeverity?: unknown } | Record<string, unknown>,
): unknown {
  return (settings as { toolSeverity?: unknown }).toolSeverity;
}
