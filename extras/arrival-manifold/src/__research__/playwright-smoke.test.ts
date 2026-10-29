// Real-world smoke test: wires arrival-manifold into the ACTUAL @playwright/mcp server
// (spawned via npx, headless) and drives a real page load through the collapsed `manifold`
// tool — no fakes anywhere in this file. Opt-in (`pnpm research`): slow (npx + browser
// launch), network-dependent, not part of the default CI gate.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, describe, expect, it } from "vitest";

import { connectServer, type UpstreamClient } from "../connect.js";
import { buildManifoldServer } from "../server.js";

const upstreamTransport = new StdioClientTransport({
  command: "npx",
  args: ["-y", "@playwright/mcp@0.0.77", "--headless"],
});

describe("arrival-manifold + real @playwright/mcp", () => {
  let testClient: Client;
  let upstreamClient: UpstreamClient;

  afterAll(async () => {
    await testClient.close();
    await upstreamClient.close();
  });

  it("collapses 23 real playwright tools into one manifold tool with a readable catalog", async () => {
    const connected = await connectServer("playwright", upstreamTransport);
    upstreamClient = connected.client;
    expect(connected.tools.length).toBeGreaterThan(15);

    const manifoldServer = await buildManifoldServer([connected]);
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await manifoldServer.connect(serverTransport);
    testClient = new Client({ name: "smoke-test", version: "0.1.0" });
    await testClient.connect(clientTransport);

    const { tools } = await testClient.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe("manifold");
    expect(tools[0]?.description).toContain("playwright_browser_navigate");
    expect(tools[0]?.description).toContain("playwright_browser_snapshot");

    // Real-world confirmation of the fallback path: @playwright/mcp declares outputSchema on
    // NONE of its 23 tools (verified directly against the server), so every one of its lines
    // must render with no -> suffix, and the catalog's default-return-shape note must appear
    // to cover them. This is the actual case the fallback exists for, not a hypothetical.
    expect(connected.tools.every((t) => !t.outputSchema)).toBe(true);
    expect(tools[0]?.description).not.toMatch(/browser_navigate\)\s*->/);
    expect(tools[0]?.description).toMatch(/content block/i);
  });

  it("navigates a real headless browser to example.com and reads back a real accessibility snapshot", async () => {
    const result = (await testClient.callTool({
      name: "manifold",
      arguments: {
        expr: '(playwright_browser_navigate :url "https://example.com")\n(playwright_browser_snapshot)',
      },
    })) as CallToolResult;

    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ type: string; text: string }>).map((b) => b.text).join("\n");
    expect(text).toMatch(/Example Domain/i);
  });
});
