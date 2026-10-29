import { describe, expect, it } from "vitest";

import { discoverMcpConnectionTools } from "../discovery.js";

function listed(...names: string[]) {
  return names.map((serverToolName) => ({
    serverToolName,
    parameters: { type: "object", properties: {} },
    class: "effect",
  }));
}

describe("MCP discovery projection", () => {
  it("applies tools filter to live listed tools", () => {
    expect(
      discoverMcpConnectionTools({
        live: {
          tools: listed("get_issue", "list_issues", "get_secret", "merge_pull_request"),
        },
        configuration: { tools: ["get_*", "list_*", "!get_secret"] },
      }).map((tool) => tool.serverToolName),
    ).toEqual(["get_issue", "list_issues"]);
  });
});
