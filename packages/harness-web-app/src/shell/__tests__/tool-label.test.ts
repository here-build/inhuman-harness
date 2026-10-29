import { describe, expect, it } from "vitest";

import { toolLabel } from "../tool-label.js";

describe("toolLabel", () => {
  it("names an MCP server and its tool", () => {
    expect(toolLabel("mcp__github__issue_read")).toBe("GitHub · issue read");
    expect(toolLabel("mcp__gitlab__create_merge_request")).toBe("GitLab · create merge request");
    expect(toolLabel("mcp__linear__issue_create")).toBe("Linear · issue create");
    expect(toolLabel("mcp__slack__post_message")).toBe("Slack · post message");
    expect(toolLabel("mcp__notion__search")).toBe("Notion · search");
    expect(toolLabel("mcp__gmail__send_email")).toBe("Gmail · send email");
    expect(toolLabel("MCP__GitHub__Issue_Read")).toBe("GitHub · issue read");
  });

  it("says scheme_repl as Scheme", () => {
    expect(toolLabel("scheme_repl")).toBe("Scheme");
    expect(toolLabel("SCHEME_REPL")).toBe("Scheme");
  });

  it("splits a package tool and a snake_case name into words", () => {
    expect(toolLabel("task__create")).toBe("Task · create");
    expect(toolLabel("agent__ask")).toBe("Agent · ask");
    expect(toolLabel("read_file")).toBe("read file");
    expect(toolLabel("scheme_watch")).toBe("scheme watch");
    expect(toolLabel("shell")).toBe("shell");
  });

  it("trims and keeps an empty name empty", () => {
    expect(toolLabel("  read_file  ")).toBe("read file");
    expect(toolLabel("")).toBe("");
    expect(toolLabel("   ")).toBe("");
  });
});
