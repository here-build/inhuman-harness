import { randomUUID } from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, describe, expect, it } from "vitest";

import { connectServer } from "../connect.js";
import { buildTransport } from "../transport.js";

describe("buildTransport", () => {
  describe("against a real local HTTP MCP server", () => {
    let httpServer: HttpServer;
    let port: number;

    afterAll(async () => {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    });

    it("connects over real HTTP (localhost) and lists the upstream's tools", async () => {
      const upstream = new Server({ name: "fake-http-upstream", version: "0.1.0" }, { capabilities: { tools: {} } });
      upstream.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [{ name: "ping", description: "Ping", inputSchema: { type: "object" } }],
      }));
      // Stateful mode (a real session id) — this SDK version's notification handling under
      // stateless mode (`sessionIdGenerator: undefined`) 500s on the post-initialize
      // notification; verified directly against the SDK, not an arrival-manifold bug.
      const serverTransport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
      await upstream.connect(serverTransport);

      httpServer = createServer((req, res) => {
        void serverTransport.handleRequest(req, res).catch((error: unknown) => {
          console.error("handleRequest failed:", error);
        });
      });
      port = await new Promise<number>((resolve) => {
        httpServer.listen(0, "127.0.0.1", () => resolve((httpServer.address() as { port: number }).port));
      });

      const clientTransport = buildTransport({
        name: "http-upstream",
        transport: "http",
        url: `http://127.0.0.1:${port}/`,
      });
      const connected = await connectServer("http-upstream", clientTransport);
      expect(connected.tools).toEqual([{ name: "ping", description: "Ping", inputSchema: { type: "object" } }]);
      await connected.client.close();
    });
  });
});
