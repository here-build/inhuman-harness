import { mcpToolRefKey } from "@inhuman.tools/harness-model";
import { ConnectionSpec, DriverSpec } from "@inhuman.tools/plexus-expectations";
import { describe, expect, it } from "vitest";

import {
  addConnectionAlwaysAllow,
  addConnectionToolExclude,
  hydrateMcpAlwaysAllows,
  mcpAlwaysRowsFromList,
  mcpSessionPersistAllows,
  mcpSessionPersistDenies,
  type McpPersistedConfig,
} from "../persist.js";

describe("MCP persist bag", () => {
  it("allowlist/blocklist/alwaysAllow/exclude lockstep with reflect", () => {
    const allow = { [mcpToolRefKey("github", "get_issue")]: "session" };
    const block = {
      [mcpToolRefKey("github", "merge_pull_request")]: "session",
    };
    expect({
      allow: {
        stem: mcpSessionPersistAllows("github", "get_issue", allow),
        alwaysVeto: mcpSessionPersistAllows("github", "merge_pull_request", {
          [mcpToolRefKey("github", "merge_pull_request")]: "always",
        }),
        empty: mcpSessionPersistAllows("github", "get_issue", {}),
        blocked: mcpSessionPersistAllows("github", "get_issue", allow, {
          [mcpToolRefKey("github", "get_issue")]: "session",
        }),
      },
      deny: {
        hit: mcpSessionPersistDenies("github", "merge_pull_request", block),
        miss: mcpSessionPersistDenies("github", "get_issue", block),
      },
    }).toEqual({
      allow: { stem: true, alwaysVeto: false, empty: false, blocked: false },
      deny: { hit: true, miss: false },
    });

    const allowlist: Record<string, string> = {};
    const github = new ConnectionSpec({
      driver: new DriverSpec({ abilityClaim: ["mcp"] }),
      name: "github",
    });
    github.configuration = { alwaysAllow: ["get_issue", "list_issues"] };
    hydrateMcpAlwaysAllows(allowlist, { github });

    const alwaysConfig: McpPersistedConfig = {
      connections: {
        github: { settings: { command: "npx" } },
      },
    };
    addConnectionAlwaysAllow(alwaysConfig, "github", "get_issue");
    addConnectionAlwaysAllow(alwaysConfig, "github", "get_issue");

    const excludeConfig: McpPersistedConfig = {
      connections: {
        github: { settings: { command: "npx" } },
      },
    };
    addConnectionToolExclude(excludeConfig, "github", "merge_pull_request");
    addConnectionToolExclude(excludeConfig, "github", "merge_pull_request");
    addConnectionToolExclude(excludeConfig, "github", "delete_file");

    const lockstep: McpPersistedConfig = {
      connections: {
        github: {
          settings: {
            command: "npx",
            tools: ["get_*"],
            alwaysAllow: ["list_issues"],
          },
        },
      },
    };
    addConnectionToolExclude(lockstep, "github", "merge_pull_request");
    addConnectionAlwaysAllow(lockstep, "github", "get_issue");

    expect({
      hydrated: allowlist,
      alwaysAllow: alwaysConfig.connections.github,
      alwaysRows: mcpAlwaysRowsFromList({
        [mcpToolRefKey("github", "get_issue")]: "always",
      }),
      exclude: excludeConfig.connections.github?.settings.tools,
      lockstep: lockstep.connections.github,
    }).toEqual({
      hydrated: {
        [mcpToolRefKey("github", "get_issue")]: "always",
        [mcpToolRefKey("github", "list_issues")]: "always",
      },
      alwaysAllow: {
        settings: { command: "npx", alwaysAllow: ["get_issue"] },
      },
      alwaysRows: [{ connectionKey: "github", serverToolName: "get_issue" }],
      exclude: ["!merge_pull_request", "!delete_file"],
      lockstep: {
        settings: {
          command: "npx",
          tools: ["get_*", "!merge_pull_request"],
          alwaysAllow: ["list_issues", "get_issue"],
        },
      },
    });
  });
});
