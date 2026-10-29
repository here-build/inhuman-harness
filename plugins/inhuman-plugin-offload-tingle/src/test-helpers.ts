/**
 * Test helpers for memory MCP process tests.
 */
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export async function connectMemoryMcp(workspacePath: string): Promise<Client> {
  const entry = fileURLToPath(new URL("../dist/memory-mcp.js", import.meta.url));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env: { MEMORY_WORKSPACE: workspacePath, MEMORY_CONTRIBUTION_REVISION: "test-rev" },
  });
  const client = new Client({ name: "memory-test", version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

export function parseToolJson(result: { content: Array<{ type: string; text?: string }> }): unknown {
  const text = result.content[0]?.text ?? "";
  return JSON.parse(text);
}
