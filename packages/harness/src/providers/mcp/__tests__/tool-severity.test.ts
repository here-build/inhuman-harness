import { describe, expect, it } from "vitest";

import { mcpCatalogClassOf, mcpToolSeverityOf } from "../tool-severity.js";

describe("MCP toolSeverity overlay", () => {
  it.each([
    {
      name: "missing bag leaves auto",
      raw: undefined,
      tool: "get_issue",
      hit: undefined,
      cls: "read",
    },
    {
      name: "malformed bag leaves auto",
      raw: ["view"],
      tool: "get_issue",
      hit: undefined,
      cls: "read",
    },
    {
      name: "exact view",
      raw: { get_issue: "view" },
      tool: "get_issue",
      hit: "view",
      cls: "read",
    },
    {
      name: "exact effect",
      raw: { send_message: "effect" },
      tool: "send_message",
      hit: "effect",
      cls: "effect",
    },
    {
      name: "exact irreversible-effect",
      raw: { merge_pull_request: "irreversible-effect" },
      tool: "merge_pull_request",
      hit: "irreversible-effect",
      cls: "write",
    },
    {
      name: "unknown name keeps auto",
      raw: { send_message: "effect" },
      tool: "get_issue",
      hit: undefined,
      cls: "read",
    },
    {
      name: "bad value is skipped",
      raw: { get_issue: "read" },
      tool: "get_issue",
      hit: undefined,
      cls: "read",
    },
    {
      name: "destructive is not a pole",
      raw: { merge_pull_request: "destructive" },
      tool: "merge_pull_request",
      hit: undefined,
      cls: "write",
    },
    {
      name: "last matching glob wins",
      raw: {
        "*": "effect",
        "get_*": "view",
        get_secret: "irreversible-effect",
      },
      tool: "get_secret",
      hit: "irreversible-effect",
      cls: "write",
    },
  ])("$name", ({ raw, tool, hit, cls }) => {
    expect({
      hit: mcpToolSeverityOf(raw, tool),
      cls: mcpCatalogClassOf(tool, tool.startsWith("get_") ? "read" : "write", raw),
    }).toEqual({ hit, cls });
  });
});
