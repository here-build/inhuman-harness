import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";

import { connectServer } from "../connect.js";

/** A fake upstream MCP server exposing one tool, wired to one end of an in-memory transport
 *  pair — no real subprocess, no network. `connectServer` gets the other end. */
async function fakeUpstream() {
  const server = new Server({ name: "fake-upstream", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "search-issues",
        description: "Search issues",
        inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => ({
    content: [{ type: "text", text: `searched: ${(request.params.arguments as { query: string }).query}` }],
  }));
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  return clientTransport;
}

describe("connectServer", () => {
  it("connects a client over the given transport and lists the upstream's tools", async () => {
    const transport = await fakeUpstream();
    const connected = await connectServer("github", transport);

    expect(connected.slug).toBe("github");
    expect(connected.tools).toEqual([
      {
        name: "search-issues",
        description: "Search issues",
        inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      },
    ]);
  });

  it("returns a client that can actually call an upstream tool", async () => {
    const transport = await fakeUpstream();
    const { client } = await connectServer("github", transport);
    const result = await client.callTool({ name: "search-issues", arguments: { query: "bug" } });
    expect(result.content).toEqual([{ type: "text", text: "searched: bug" }]);
  });
});
