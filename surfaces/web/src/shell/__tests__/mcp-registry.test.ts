import { describe, expect, it } from "vitest";

import {
  connectionInstall,
  mcpCopies,
  mcpLoginLine,
  registryAddLabel,
  registryHits,
  type McpFace,
} from "../mcp-registry.js";

const HTTP = "https://mcp.sentry.dev/mcp";

function face(patch: McpFace): McpFace {
  return { driver: { name: "mcp-http", abilityClaim: ["mcp"] }, configuration: { url: HTTP }, ...patch };
}

describe("mcp login", () => {
  it("names the person when an HTTP server is ready", () => {
    expect(
      mcpLoginLine(
        face({
          readyState: "ready",
          live: { identity: { displayName: "Ada", plan: "plus" } },
        }),
        "Sentry",
      ),
    ).toBe("Signed in as Ada");
  });

  it("says signed in when a ready HTTP server reports no person", () => {
    expect(mcpLoginLine(face({ readyState: "ready", live: { identity: { plan: "plus" } } }))).toBe("Signed in");
  });

  it("says signed out while an HTTP server is idle", () => {
    expect(mcpLoginLine(face({ readyState: "idle" }))).toBe("Signed out");
  });

  it("asks for a login when the server needs auth, including a refused key", () => {
    expect(
      mcpLoginLine(face({ readyState: "ready", live: { auth: "needs-auth", identity: { displayName: "Ada" } } })),
    ).toBe("Log in");
    expect(mcpLoginLine(face({ readyState: "failed", error: "HTTP 401" }), "Sentry")).toBe("Log in");
  });

  it("keeps a dead socket ahead of a login prompt", () => {
    expect(
      mcpLoginLine(
        face({
          readyState: "failed",
          error: "connect ETIMEDOUT 10.0.0.1:1",
          live: { auth: "needs-auth", identity: { displayName: "Ada" } },
        }),
        "Sentry",
      ),
    ).toBe("No answer from Sentry.");
  });

  it("treats a stdio process as ready or idle", () => {
    expect(mcpLoginLine({ driver: { name: "mcp-stdio" }, readyState: "ready" })).toBe("Ready");
    expect(mcpLoginLine({ driver: { name: "mcp-stdio" }, readyState: "idle" })).toBe("Idle");
  });
});

describe("registry copies", () => {
  it("lists every connected copy of one install, each with its own login", () => {
    const rows: (readonly [string, McpFace])[] = [
      [
        "sentry",
        face({
          name: "Sentry",
          readyState: "ready",
          live: { identity: { displayName: "Ada" } },
        }),
      ],
      [
        "sentry-2",
        face({
          name: "Sentry",
          readyState: "ready",
          live: { auth: "needs-auth" },
        }),
      ],
      ["other", face({ name: "Other", configuration: { url: "https://other.test/mcp" }, readyState: "ready" })],
    ];
    expect(mcpCopies(rows, HTTP)).toEqual([
      { id: "sentry", name: "Sentry", login: "Signed in as Ada" },
      { id: "sentry-2", name: "Sentry", login: "Log in" },
    ]);
    expect(registryAddLabel("Sentry", HTTP, 2)).toBe("Add another Sentry");
    expect(registryAddLabel("Notes", "npx -y notes", 0)).toBe("Add Notes");
  });

  it("matches a stdio command whether it was stored split or as one line", () => {
    expect(connectionInstall({ command: "npx", args: ["-y", "notes-mcp"] })).toBe("npx -y notes-mcp");
    const rows: (readonly [string, McpFace])[] = [
      [
        "notes",
        {
          name: "Notes",
          driver: { name: "mcp-stdio" },
          configuration: { command: "npx -y notes-mcp" },
          readyState: "ready",
        },
      ],
    ];
    expect(mcpCopies(rows, "npx  -y   notes-mcp")).toEqual([{ id: "notes", name: "Notes", login: "Ready" }]);
  });

  it("reads a search result and drops a row without a title", () => {
    expect(
      registryHits({
        servers: [
          { name: "dev.sentry/mcp", title: "Sentry", description: "Errors.", install: HTTP },
          { name: "com.example/bare", description: "No title." },
        ],
      }),
    ).toEqual([{ name: "dev.sentry/mcp", title: "Sentry", description: "Errors.", install: HTTP }]);
  });
});
