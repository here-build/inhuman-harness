/** MCP HTTP TFRP freshness: handshake on the wire; send waits; audience is this row. */
import { extraLiveFromState } from "@inhuman.tools/plexus-expectations/driver";
import { runInAction } from "mobx";
import { afterEach, describe, expect, it } from "vitest";

import { stampBearer } from "../config.js";
import { McpHttpDriverConnection, mcpAccessExpiring } from "../http-driver.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const NOW = 1_700_000_000_000;

describe("mcp-http TFRP freshness", () => {
  it("empty slot is fresh until challenged; nowMs stays off spec.live", () => {
    const connection = new McpHttpDriverConnection("mcp", {
      url: "https://mcp.example/mcp",
    });
    connection.tick(NOW);
    expect({
      fresh: connection.fresh,
      expiring: connection.expiring,
      needsAuth: connection.needsAuth,
      live: extraLiveFromState(connection.state),
    }).toEqual({
      fresh: true,
      expiring: false,
      needsAuth: false,
      live: expect.not.objectContaining({ nowMs: expect.anything() }),
    });
    void connection[Symbol.asyncDispose]();
  });

  it("expires_at over nowMs; absent / unparseable is not expired", () => {
    expect(mcpAccessExpiring(undefined, NOW)).toBe(false);
    expect(mcpAccessExpiring("not-a-date", NOW)).toBe(false);
    expect(mcpAccessExpiring(String(NOW / 1000 + 60), NOW)).toBe(true);
    expect(mcpAccessExpiring(String(NOW / 1000 + 20 * 60), NOW)).toBe(false);
    const connection = new McpHttpDriverConnection(
      "mcp",
      { url: "https://mcp.example/mcp" },
      {
        token: "tok",
        refresh_token: "rt",
        expires_at: String(NOW / 1000 + 60),
        token_endpoint: "https://as.example/token",
      },
    );
    connection.tick(NOW);
    expect({ expiring: connection.expiring, fresh: connection.fresh }).toEqual({
      expiring: true,
      fresh: false,
    });
    void connection[Symbol.asyncDispose]();
  });

  it("audience: neighboring secrets never enter an MCP stamp", () => {
    const mcpSecrets = {
      get: (field: string) => (field === "token" ? "mcp-tok" : undefined),
    };
    const stamped = JSON.stringify(stampBearer(mcpSecrets, {}, { authorization: "Bearer leaked" }));
    expect({
      hasMcp: stamped.includes("mcp-tok"),
      leaked: stamped.includes("leaked"),
      other: stamped.includes("grok-secret"),
    }).toEqual({ hasMcp: true, leaked: false, other: false });
  });

  it("no refresh_token: 401 is ceremony (needs-auth), not a refresh grant", async () => {
    let grants = 0;
    globalThis.fetch = (async () => {
      grants += 1;
      return new Response("nope", { status: 401 });
    }) as typeof fetch;
    const connection = new McpHttpDriverConnection("mcp", {
      url: "https://mcp.example/mcp",
    });
    connection["startFreshnessWatch"]();
    connection.noteChallenge(401);
    runInAction(() => {
      connection.state.auth = "needs-auth";
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect({
      needsAuth: connection.needsAuth,
      grants,
      fresh: connection.fresh,
    }).toEqual({
      needsAuth: true,
      grants: 0,
      fresh: false,
    });
    await connection[Symbol.asyncDispose]();
  });
});
