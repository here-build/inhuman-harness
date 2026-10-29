/**
 * MCP connection tool listing after the connection `tools` filter.
 */
import { parseListedTools, type McpListedTool } from "./schemas/mcp.js";
import { filterMcpToolNames, mcpToolsSettingOf } from "./tool-filter.js";

export function discoverMcpConnectionTools(spec: {
  readonly live: { readonly tools?: unknown };
  readonly configuration?: unknown;
}): readonly McpListedTool[] {
  const listed = parseListedTools(spec.live.tools);
  const configuration =
    spec.configuration != null && typeof spec.configuration === "object"
      ? (spec.configuration as Record<string, unknown>)
      : {};
  const allowed = new Set(
    filterMcpToolNames(
      listed.map((tool) => tool.serverToolName),
      mcpToolsSettingOf(configuration),
    ),
  );
  return listed.filter((tool) => allowed.has(tool.serverToolName));
}
