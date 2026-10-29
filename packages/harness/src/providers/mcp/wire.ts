/**
 * @/providers/mcp/wire — the one door the generic runtime uses into the MCP
 * provider: pure readers over a connection's `live.tools` and settings. Its
 * closure holds no driver, SDK client, or OAuth, so importing it does not
 * load the transport.
 */

export { isMcpDriver as isMcpDriver } from "./config.js";
export { discoverMcpConnectionTools as discoverMcpConnectionTools } from "./discovery.js";
export { parseListedTools as parseListedTools, type McpListedTool as McpListedTool } from "./schemas/mcp.js";
export {
  mcpCatalogClassOf as mcpCatalogClassOf,
  mcpToolSeveritySettingOf as mcpToolSeveritySettingOf,
} from "./tool-severity.js";
