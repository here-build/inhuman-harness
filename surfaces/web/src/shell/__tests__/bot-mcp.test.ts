import { describe, expect, it } from "vitest";

import { mcpDrafts, mcpPayload, mcpServerOptions, serverChoices, type McpConnectionFace } from "../bot-mcp.js";

const notes: McpConnectionFace = {
  name: "notes",
  driver: { abilityClaim: ["mcp"] },
  configuration: { project: "/work", account: "desk", session: "s1" },
  live: { tools: [{ name: "write" }, { serverToolName: "search" }] },
};

const sentry: McpConnectionFace = {
  name: "Sentry",
  driver: { abilityClaim: ["mcp"] },
  configuration: { url: "https://mcp.sentry.dev/mcp" },
  live: { tools: ["list_issues"] },
};

describe("bot MCP choices", () => {
  const connections = {
    notes,
    "notes-lab": { ...notes, configuration: { project: "/work", account: "lab" } },
    sentry,
    elsewhere: { ...notes, name: "notes", configuration: { project: "/else", account: "desk" } },
    chat: { name: "ChatGPT", driver: { abilityClaim: ["completion"] }, configuration: {} },
    __prv_hidden: { name: "hidden", driver: { abilityClaim: ["mcp"] }, configuration: {} },
  };

  it("offers project servers to a project bot and global servers to a global bot", () => {
    expect(mcpServerOptions(connections, "project", "/work").map((option) => option.server)).toEqual(["notes"]);
    expect(mcpServerOptions(connections, "session", "/work")).toEqual(
      mcpServerOptions(connections, "project", "/work"),
    );
    expect(mcpServerOptions(connections, "global", "/work").map((option) => option.server)).toEqual(["Sentry"]);
    expect(mcpServerOptions(connections, "project", "")).toEqual([]);
    expect(mcpServerOptions(connections, "project", "/work")[0]).toEqual({
      server: "notes",
      accounts: ["desk", "lab"],
      sessions: ["s1"],
      tools: ["search", "write"],
    });
  });

  it("keeps a grant whose server is outside the current pool", () => {
    expect(
      serverChoices(mcpServerOptions(connections, "global", "/work"), "notes").map((option) => option.server),
    ).toEqual(["Sentry", "notes"]);
  });

  it("round-trips a grant and drops a blank server or an empty constraint", () => {
    const stored = JSON.stringify(
      mcpPayload([{ server: " notes ", tools: "search, write", account: " desk ", session: "" }]),
    );
    expect(mcpDrafts(stored)).toEqual([{ server: "notes", tools: "search, write", account: "desk", session: "" }]);
    expect(mcpPayload([{ server: " ", tools: "search", account: "", session: "" }])).toEqual([]);
  });
});
