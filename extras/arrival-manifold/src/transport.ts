// transport — builds the right MCP client Transport for a config entry. stdio spawns a
// subprocess; http speaks the Streamable HTTP transport directly.

import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import type { ManifoldServerConfig } from "./config.js";

export function buildTransport(config: ManifoldServerConfig): Transport {
  if (config.transport === "stdio") {
    return new StdioClientTransport({ command: config.command, args: config.args, env: config.env });
  }
  return new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: config.headers ? { headers: config.headers } : undefined,
  });
}
