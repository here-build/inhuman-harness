import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";

import { connectServer } from "../connect.js";
import { buildManifoldServer } from "../server.js";

/** A fake upstream MCP server exposing one tool, reachable only through an in-memory
 *  transport pair — no real subprocess anywhere in this test. */
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

/** Connects a fresh test Client to the manifold server under test, over its own in-memory pair. */
async function connectToManifold(manifoldServer: Server) {
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await manifoldServer.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.1.0" });
  await client.connect(clientTransport);
  return client;
}

describe("buildManifoldServer", () => {
  it("exposes exactly one tool, named manifold, whose catalog lists the upstream's tools", async () => {
    const upstream = await connectServer("github", await fakeUpstream());
    const manifoldServer = await buildManifoldServer([upstream]);
    const client = await connectToManifold(manifoldServer);

    const { tools } = await client.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe("scheme-repl-with-all-mcp-tools");
    expect(tools[0]?.description).toContain("github/search-issues");
  });

  it("passes a real upstream tool's outputSchema through into the manifold catalog's -> suffix", async () => {
    const server = new Server({ name: "fake-upstream", version: "0.1.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "search-issues",
          description: "Search issues",
          inputSchema: { type: "object" },
          outputSchema: { type: "object", properties: { count: { type: "number" } }, required: ["count"] },
        },
      ],
    }));
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const upstream = await connectServer("github", clientTransport);
    const manifoldServer = await buildManifoldServer([upstream]);
    const client = await connectToManifold(manifoldServer);

    const { tools } = await client.listTools();
    expect(tools[0]?.description).toContain("(github/search-issues) -> {count:number} - Search issues");
  });

  it("routes a manifold expr call through to the real upstream tool and returns its result", async () => {
    const upstream = await connectServer("github", await fakeUpstream());
    const manifoldServer = await buildManifoldServer([upstream]);
    const client = await connectToManifold(manifoldServer);

    const result = await client.callTool({
      name: "scheme-repl-with-all-mcp-tools",
      arguments: { expr: '(github/search-issues :query "bug")' },
    });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toContain("searched: bug");
  });
});

describe("abort-signal propagation to the REAL upstream MCP request", () => {
  // H-1's outer timeout race (manifold-tool.ts) already aborts its OWN parked wait — that part
  // is covered by timeout.test.ts's "unparks an eval stuck inside a never-resolving tool call"
  // using a hand-rolled `RemoteTool.invoke` that never observes anything past its own promise.
  // This test proves the DEEPER claim: the abort reaches the ACTUAL wire-level MCP request to a
  // real upstream server (bind.ts's rosettaDef → server.ts's toBoundServer → the real SDK
  // `Client.callTool(..., { signal })`), which reacts by sending a genuine
  // `notifications/cancelled` over the transport — observed here via the upstream `Server`'s own
  // `RequestHandlerExtra.signal` (the receiving end of that exact notification, per the MCP SDK).
  it("a genuinely stuck upstream tool call is cancelled at the wire level when the manifold call's outer timeout fires", async () => {
    let sawAbort = false;
    let notifyAbort: (() => void) | undefined;
    const abortSeen = new Promise<void>((resolve) => {
      notifyAbort = resolve;
    });

    const server = new Server({ name: "fake-upstream", version: "0.1.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{ name: "stuck", description: "never resolves on its own", inputSchema: { type: "object" } }],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (_request, extra) => {
      // A well-behaved upstream tool: it never resolves by itself, but DOES react to the MCP
      // SDK's own cancellation channel (`notifications/cancelled`, sent by `client.callTool`
      // when ITS `RequestOptions.signal` aborts) — proving the abort reached the ACTUAL wire
      // request, not merely manifold-tool.ts's local wait.
      await new Promise<void>((_resolve, reject) => {
        extra.signal.addEventListener("abort", () => {
          sawAbort = true;
          notifyAbort?.();
          reject(new Error("cancelled"));
        });
      });
      return { content: [{ type: "text", text: "should never get here" }] };
    });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const upstream = await connectServer("slow", clientTransport);
    const manifoldServer = await buildManifoldServer([upstream], { timeoutMs: 150 });
    const client = await connectToManifold(manifoldServer);

    const start = Date.now();
    const result = await client.callTool({
      name: "scheme-repl-with-all-mcp-tools",
      arguments: { expr: "(slow/stuck)" },
    });
    expect(result.isError).toBe(true);
    // 150ms budget + manifold-tool.ts's 250ms parked grace, generous slack for CI scheduling.
    expect(Date.now() - start).toBeLessThan(3000);

    // The cancellation notice travels over the (in-memory) transport asynchronously — wait for
    // the upstream handler to actually observe it, bounded so a regression (the signal never
    // reaching `client.callTool`) fails the test instead of hanging forever.
    await Promise.race([
      abortSeen,
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error("upstream never saw the abort")), 2000)),
    ]);
    expect(sawAbort).toBe(true);
  });
});

/** A fake upstream exposing two tools, for allowlist filtering tests. */
async function fakeUpstreamWithTwoTools() {
  const server = new Server({ name: "fake-upstream", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: "search-issues", description: "Search issues", inputSchema: { type: "object" } },
      { name: "create-issue", description: "Create an issue", inputSchema: { type: "object" } },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async () => ({
    content: [{ type: "text", text: "ok" }],
  }));
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  return clientTransport;
}

describe("per-server tool allowlist", () => {
  it("filters bind + catalog to only the allowlisted tool", async () => {
    const upstream = await connectServer("github", await fakeUpstreamWithTwoTools());
    const manifoldServer = await buildManifoldServer([upstream], {
      toolAllowlist: { github: ["search-issues"] },
    });
    const client = await connectToManifold(manifoldServer);

    const { tools } = await client.listTools();
    expect(tools[0]?.description).toContain("github/search-issues");
    expect(tools[0]?.description).not.toContain("github/create-issue");

    // The unlisted tool neither bound nor callable — an ordinary unbound-variable error.
    const result = await client.callTool({
      name: "scheme-repl-with-all-mcp-tools",
      arguments: { expr: "(github/create-issue)" },
    });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0]?.text).toContain("Unbound variable");
  });

  it("absent allowlist leaves behavior unchanged (all tools bind)", async () => {
    const upstream = await connectServer("github", await fakeUpstreamWithTwoTools());
    const manifoldServer = await buildManifoldServer([upstream]);
    const client = await connectToManifold(manifoldServer);

    const { tools } = await client.listTools();
    expect(tools[0]?.description).toContain("github/search-issues");
    expect(tools[0]?.description).toContain("github/create-issue");
  });

  it("a server present in the allowlist map but with no entry for its own slug is unchanged", async () => {
    const upstream = await connectServer("github", await fakeUpstreamWithTwoTools());
    const manifoldServer = await buildManifoldServer([upstream], { toolAllowlist: { other: ["whatever"] } });
    const client = await connectToManifold(manifoldServer);

    const { tools } = await client.listTools();
    expect(tools[0]?.description).toContain("github/search-issues");
    expect(tools[0]?.description).toContain("github/create-issue");
  });

  it("throws a loud config error, listing available names, when an allowlisted name doesn't exist", async () => {
    const upstream = await connectServer("github", await fakeUpstreamWithTwoTools());
    await expect(
      buildManifoldServer([upstream], { toolAllowlist: { github: ["search-issues", "delete-issue"] } }),
    ).rejects.toThrow(/delete-issue.*available.*search-issues.*create-issue/s);
  });
});
