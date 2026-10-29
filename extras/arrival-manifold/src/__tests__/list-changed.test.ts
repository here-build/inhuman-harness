// H-2 — tools/listChanged. On an upstream's notification the manifold re-lists that
// server and REBUILDS THE WORLD (env + catalog + tool; see server.ts's design note), then
// swaps it in atomically between evals and notifies its own downstream client. An eval
// already in flight finishes against the OLD world undisturbed.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ToolListChangedNotificationSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";

import { connectServer } from "../connect.js";
import { buildManifoldServer } from "../server.js";

interface MutableUpstream {
  server: Server;
  clientTransport: InMemoryTransport;
  setTools(tools: Tool[]): void;
}

/** A fake upstream whose tool list can be swapped mid-session; `alpha` answers instantly,
 *  `slow-alpha` parks on a caller-controlled gate (for the in-flight test). */
async function mutableUpstream(gate?: Promise<unknown>): Promise<MutableUpstream> {
  const server = new Server(
    { name: "fake-upstream", version: "0.1.0" },
    { capabilities: { tools: { listChanged: true } } },
  );
  let tools: Tool[] = [
    { name: "alpha", description: "The first tool", inputSchema: { type: "object" } },
    { name: "slow-alpha", description: "Parks on the test gate", inputSchema: { type: "object" } },
  ];
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name === "slow-alpha") await gate;
    return { content: [{ type: "text", text: `ran: ${request.params.name}` }] };
  });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  return {
    server,
    clientTransport,
    setTools: (next) => {
      tools = next;
    },
  };
}

async function connectToManifold(manifoldServer: Server) {
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await manifoldServer.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.1.0" });
  await client.connect(clientTransport);
  return client;
}

const catalogOf = async (client: Client): Promise<string> => {
  const { tools } = await client.listTools();
  return tools[0]?.description ?? "";
};

describe("tools/listChanged (H-2)", () => {
  it("re-lists the notifying upstream and rebuilds env + catalog — new tool callable, old one gone", async () => {
    const upstream = await mutableUpstream();
    const connected = await connectServer("up", upstream.clientTransport);
    const manifoldServer = await buildManifoldServer([connected]);
    const client = await connectToManifold(manifoldServer);

    expect(await catalogOf(client)).toContain("up/alpha");

    upstream.setTools([{ name: "beta", description: "The replacement tool", inputSchema: { type: "object" } }]);
    await upstream.server.sendToolListChanged();

    await vi.waitFor(async () => {
      const catalog = await catalogOf(client);
      expect(catalog).toContain("up/beta");
      expect(catalog).not.toContain("up/alpha");
    });

    const beta = await client.callTool({ name: "scheme-repl-with-all-mcp-tools", arguments: { expr: "(up/beta)" } });
    expect(beta.isError).toBeFalsy();
    expect((beta.content as Array<{ text: string }>)[0]?.text).toContain("ran: beta");

    // The old binding is gone from the rebuilt env — calling it is an ordinary unbound error.
    const alpha = await client.callTool({ name: "scheme-repl-with-all-mcp-tools", arguments: { expr: "(up/alpha)" } });
    expect(alpha.isError).toBe(true);
    expect((alpha.content as Array<{ text: string }>)[0]?.text).toContain("Unbound variable");
  });

  it("notifies its own downstream client that the manifold tool changed (catalog is its description)", async () => {
    const upstream = await mutableUpstream();
    const connected = await connectServer("up", upstream.clientTransport);
    const manifoldServer = await buildManifoldServer([connected]);
    const client = await connectToManifold(manifoldServer);

    let notified = false;
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      notified = true;
    });

    upstream.setTools([{ name: "beta", inputSchema: { type: "object" } }]);
    await upstream.server.sendToolListChanged();
    await vi.waitFor(() => expect(notified).toBe(true));
  });

  it("an eval in flight during the rebuild finishes against the OLD world undisturbed", async () => {
    let release!: (v: unknown) => void;
    const gate = new Promise((resolve) => (release = resolve));
    const upstream = await mutableUpstream(gate);
    const connected = await connectServer("up", upstream.clientTransport);
    const manifoldServer = await buildManifoldServer([connected]);
    const client = await connectToManifold(manifoldServer);

    // Start an eval that parks inside the upstream tool...
    const inFlight = client.callTool({
      name: "scheme-repl-with-all-mcp-tools",
      arguments: { expr: "(up/slow-alpha)" },
    });

    // ...swap the world out from under it...
    upstream.setTools([{ name: "beta", inputSchema: { type: "object" } }]);
    await upstream.server.sendToolListChanged();
    await vi.waitFor(async () => expect(await catalogOf(client)).toContain("up/beta"));

    // ...then let it finish: it still completes with the OLD tool's result.
    release(undefined);
    const result = await inFlight;
    expect(result.isError).toBeFalsy();
    expect((result.content as Array<{ text: string }>)[0]?.text).toContain("ran: slow-alpha");
  });
});
