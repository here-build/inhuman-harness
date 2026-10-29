/**
 * MCP driver-provider registration. Product composition adds this to the
 * roster. Not a plugin manifest and not a neighboring vendor.
 */
import {
  parseProviderRegistration,
  PROVIDER_SDK_CONTRACT,
  type RegisteredProvider,
} from "@inhuman.tools/harness-provider-sdk";

import { McpHttpDriverConnection } from "./http-driver.js";
import { McpStdioDriverConnection } from "./stdio-driver.js";

export const MCP_PROVIDER_ID = "mcp";
export const MCP_STDIO_DRIVER = "mcp-stdio";
export const MCP_HTTP_DRIVER = "mcp-http";

export const mcpProvider: RegisteredProvider = parseProviderRegistration({
  id: MCP_PROVIDER_ID,
  name: "MCP",
  description: "Model Context Protocol HTTP and stdio drivers",
  contract: PROVIDER_SDK_CONTRACT,
  drivers: [
    {
      name: MCP_STDIO_DRIVER,
      description: "MCP stdio",
      abilityClaim: ["mcp"],
      multiplicity: "add-as-secondary",
      connection: McpStdioDriverConnection,
    },
    {
      name: MCP_HTTP_DRIVER,
      description: "MCP Streamable HTTP",
      abilityClaim: ["mcp"],
      multiplicity: "add-as-secondary",
      connection: McpHttpDriverConnection,
    },
  ],
});
