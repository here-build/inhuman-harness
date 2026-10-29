import { describe, expect, it } from "vitest";

import {
  admitPrivateMcpTool,
  pluginContributionRevision,
  type PrivateMcpInstallState,
  type PrivateMcpPluginRecord,
} from "../private-mcp.js";

function install(record: PrivateMcpPluginRecord): PrivateMcpInstallState {
  return { plugins: new Map([[record.pluginName, record]]) };
}

function memoryPlugin(
  tools: readonly string[] = ["find", "read"],
  listedTools: readonly string[] = ["find", "read", "commit"],
): PrivateMcpPluginRecord {
  return {
    pluginName: "abi-fixture",
    definition: {
      mcpServers: [
        {
          name: "memory",
          visibility: "private",
          scope: "workspace",
          transport: {
            type: "stdio",
            command: "node",
            args: ["./memory-mcp.js"],
            cwd: "plugin",
          },
        },
      ],
    },
    privateServers: [
      {
        pluginName: "abi-fixture",
        definition: {
          name: "memory",
          visibility: "private",
          scope: "workspace",
          transport: {
            type: "stdio",
            command: "node",
            args: ["./memory-mcp.js"],
            cwd: "plugin",
          },
        },
        listedTools,
      },
    ],
    bindings: [
      {
        pluginName: "abi-fixture",
        botName: "worker",
        serverName: "memory",
        tools,
        approval: "allow",
      },
    ],
  };
}

describe("private MCP admission", () => {
  it("foreground is denied; workers are bound to listed tools only", () => {
    const state = install(memoryPlugin(["find", "read"]));
    const scout = install({
      ...memoryPlugin(["find", "read"]),
      bindings: [
        {
          pluginName: "abi-fixture",
          botName: "scout",
          serverName: "memory",
          tools: ["find", "read"],
          approval: "allow",
        },
      ],
    });
    expect({
      foreground: admitPrivateMcpTool(state, "", "abi-fixture", "memory", "commit"),
      workerFind: admitPrivateMcpTool(state, "worker", "abi-fixture", "memory", "find"),
      workerCommit: admitPrivateMcpTool(state, "worker", "abi-fixture", "memory", "commit"),
      scoutCommit: admitPrivateMcpTool(scout, "scout", "abi-fixture", "memory", "commit"),
    }).toEqual({
      foreground: expect.objectContaining({
        allowed: false,
        reason: "foreground cannot call private MCP tools",
      }),
      workerFind: { allowed: true },
      workerCommit: expect.objectContaining({
        allowed: false,
        reason: "worker cannot use commit on memory",
      }),
      scoutCommit: expect.objectContaining({ allowed: false }),
    });
  });

  it("revision is stable for the same definition", () => {
    const record = memoryPlugin();
    expect(pluginContributionRevision(record)).toBe(pluginContributionRevision(record));
    expect(pluginContributionRevision(record)).toHaveLength(16);
  });
});
