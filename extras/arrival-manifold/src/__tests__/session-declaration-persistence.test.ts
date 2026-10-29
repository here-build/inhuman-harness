// SESSION DECLARATION PERSISTENCE — a top-level `(define ...)` submitted in one manifold
// tool call must be available in the NEXT tool call within the same session.
//
// The manifold ALREADY persists defines call-to-call via a PERSISTENT live env. Proof:
// server.ts's `buildManifoldServer` constructs exactly ONE `ManifoldTool` per "world" (see
// its `rebuild()`), and `createManifoldTool` (manifold-tool.ts) closes over that ONE
// `SchemeEnv` instance for every `call()` for as long as the tool lives — every statement
// runs `exec(statement, { env, ... })` against the SAME env object. The world (env + tool)
// is only ever replaced wholesale on a tools/listChanged notification (see
// list-changed.test.ts), which is a DELIBERATE full reset, not a per-call rebuild. So a
// `(define x 5)` in call 1 leaves a binding on the live env that call 2's `(+ x 1)` reads
// straight off it — no serialization or replay is needed for plain cross-call correctness.
// The `describe` below exercises this at the full MCP server/client boundary
// (mirroring list-changed.test.ts's harness) as direct confirmation, not new behavior.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";

import { connectServer } from "../connect.js";
import { buildManifoldServer } from "../server.js";

/** A fake upstream with one tool-valued-friendly `echo` tool, for the server/client tests. */
async function echoUpstream(): Promise<{ clientTransport: InMemoryTransport }> {
  const server = new Server({ name: "fake-upstream", version: "0.1.0" }, { capabilities: { tools: {} } });
  const tools: Tool[] = [
    {
      name: "echo",
      description: "echoes v",
      inputSchema: { type: "object", properties: { v: { type: "string" } }, required: ["v"] },
    },
  ];
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => ({
    content: [{ type: "text", text: String((request.params.arguments as { v?: string })?.v ?? "") }],
  }));
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  return { clientTransport };
}

async function connectToManifold(manifoldServer: Awaited<ReturnType<typeof buildManifoldServer>>) {
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await manifoldServer.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.1.0" });
  await client.connect(clientTransport);
  return client;
}

describe("Step 1 finding — mechanism (a): the manifold already persists defines call-to-call", () => {
  it("a define in call 1 resolves in call 2 of the same session, at the full MCP server/client boundary", async () => {
    const upstream = await echoUpstream();
    const connected = await connectServer("up", upstream.clientTransport);
    const manifoldServer = await buildManifoldServer([connected]);
    const client = await connectToManifold(manifoldServer);

    const first = await client.callTool({
      name: "scheme-repl-with-all-mcp-tools",
      arguments: { expr: "(define session-var 42)" },
    });
    expect(first.isError).toBeFalsy();

    const second = await client.callTool({
      name: "scheme-repl-with-all-mcp-tools",
      arguments: { expr: "(+ session-var 1)" },
    });
    expect(second.isError).toBeFalsy();
    expect((second.content as Array<{ text: string }>)[0]?.text).toBe("43");
  });
});
