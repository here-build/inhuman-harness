/**
 * SessionDaemon must warm enabled MCP connections before snapshotting turn
 * tools, and must re-snapshot later turns when discovered MCP tools drift even
 * when the connection id list stays identical.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dropConnection } from "@inhuman.tools/expectations/executor";
import {
  DEFAULT_COMPACT_STRATEGY,
  DEFAULT_COMPACT_TRIGGERS,
  SCHEME_REPL_TOOL_NAME,
  SessionTurn,
  type McpToolExpectation,
  type McpToolResult,
} from "@inhuman.tools/harness-model";
import { parseProviderRegistration, PROVIDER_SDK_CONTRACT } from "@inhuman.tools/harness-provider-sdk";
import { mkdtemp, writeJson } from "fs-extra";
import { runInAction, when } from "mobx";
import { describe, expect, it, onTestFinished } from "vitest";

import { openDriverRegistry } from "@/connections";
import { McpDriverConnection, McpToolActor, type McpListedTool } from "@/providers/mcp";

import { PRODUCT_PROVIDERS } from "../../../composition.js";
import { attachScriptedModel, modelOf, scriptedConnectionId } from "../../../testkit/scripted-model.js";
import { KernelDaemon } from "../../kernel/KernelDaemon.js";
import { ProjectDaemon } from "../../project/ProjectDaemon.js";

const TIMEOUT = 4_000;

let activeTools: McpListedTool[] = [];

class DynamicMcpConnection extends McpDriverConnection {
  protected override createToolActor(expectation: McpToolExpectation): McpToolActor {
    return new McpToolActor(expectation, this);
  }

  override async bootstrap(): Promise<void> {
    await Promise.resolve();
    runInAction(() => {
      this.state.tools = [...activeTools];
    });
  }

  override async callTool(): Promise<McpToolResult> {
    return { ok: true, text: "ok" };
  }
}

function schemeReplDescriptionOf(turn: SessionTurn): string {
  const entry = turn.toolsDefinition?.entries.find((item) => item.name === SCHEME_REPL_TOOL_NAME);
  return entry?.description ?? "";
}

describe("MCP catalog warm-up & resnapshot", () => {
  it("warms MCP connections before Turn 1 and re-snapshots when MCP tools change", async () => {
    const system = await mkdtemp(join(tmpdir(), "harness-mcp-snap-k-"));
    const workspace = await mkdtemp(join(tmpdir(), "harness-mcp-snap-p-"));
    activeTools = [
      {
        serverToolName: "alpha_tool",
        description: "First MCP tool",
        parameters: { type: "object", properties: {} },
        class: "read",
      },
    ];
    await writeJson(join(system, "config.json"), {
      connections: {
        kley: { driver: "dynamic-mcp", name: "Kley", settings: { enabled: true } },
      },
      compact: DEFAULT_COMPACT_STRATEGY,
      compactTriggers: { ...DEFAULT_COMPACT_TRIGGERS },
    });

    const kernel = new KernelDaemon(
      system,
      openDriverRegistry([
        ...PRODUCT_PROVIDERS,
        parseProviderRegistration({
          id: "dynamic-mcp",
          name: "dynamic-mcp",
          contract: PROVIDER_SDK_CONTRACT,
          drivers: [
            {
              name: "dynamic-mcp",
              description: "dynamic-mcp",
              abilityClaim: ["mcp"],
              multiplicity: "add-as-secondary",
              connection: DynamicMcpConnection,
            },
          ],
        }),
      ]),
    );
    await kernel.ready;
    const project = new ProjectDaemon(kernel, workspace);
    await project.ready;
    const session = await project.session("s1");
    attachScriptedModel(kernel, session);
    onTestFinished(() => {
      void session.park();
      project[Symbol.dispose]();
      kernel[Symbol.dispose]();
    });
    await session.handleRequest("kv/set", { key: "connection", value: scriptedConnectionId() });
    await session.handleRequest("kv/set", { key: "model", value: "grok-4.6" });

    // Turn 1: without warming first, Turn 1 would snapshot before DynamicMcpConnection finishes bootstrap.
    await session.handleRequest("turn", { prompt: "first turn" });
    await when(() => session.root.head instanceof SessionTurn, { timeout: TIMEOUT });
    const turn1 = session.root.head as SessionTurn;
    expect(turn1.toolsDefinition).not.toBeNull();
    expect(schemeReplDescriptionOf(turn1)).toContain("alpha_tool");
    expect(schemeReplDescriptionOf(turn1)).not.toContain("beta_tool");

    modelOf(session).reply({ text: "done 1" });
    await when(() => turn1.reducerExited, { timeout: TIMEOUT });

    // Update the server's tool catalog while keeping connection id `kley` unchanged.
    activeTools = [
      ...activeTools,
      {
        serverToolName: "beta_tool",
        description: "Second MCP tool",
        parameters: { type: "object", properties: {} },
        class: "write",
      },
    ];
    await dropConnection(kernel.doc.root, "kley");

    // Turn 2 must warm and re-snapshot `toolsDefinition` because the MCP catalog drifted.
    await session.handleRequest("turn", { prompt: "second turn" });
    await when(() => session.root.head instanceof SessionTurn && session.root.head !== turn1, { timeout: TIMEOUT });
    const turn2 = session.root.head as SessionTurn;
    expect(turn2.toolsDefinition).not.toBeNull();
    expect(schemeReplDescriptionOf(turn2)).toContain("alpha_tool");
    expect(schemeReplDescriptionOf(turn2)).toContain("beta_tool");

    modelOf(session).reply({ text: "done 2" });
    await when(() => turn2.reducerExited, { timeout: TIMEOUT });
  });
});
