/**
 * Private MCP admission is the plugin binding table.
 * The ABI fixture's private server is named "memory"; that is not a core store.
 */
import { fileURLToPath } from "node:url";

import { Plexus, resetLocalIDs } from "@here.build/plexus";
import { prompt } from "@inhuman.tools/harness-commons";
import { BotCallJob, AgentNotifyJob, SessionRoot } from "@inhuman.tools/harness-model";
import { normalizeDefinitions, resolveReferences } from "@inhuman.tools/plugin-sdk";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";

import { admitPrivateMcpTool } from "@/extensions";
import { agentCallSupportsNotify } from "@/tool-catalog";
import { ToolCallHandler } from "@/tool-runtime";

import { applyPackPlugins } from "../actor.js";
import { compilePluginInstall, mergePluginInstallState } from "../plugin-registry.js";
import { KernelToolCatalog } from "../tool-table.js";

const FIXTURE_PLUGIN = fileURLToPath(new URL("fixtures/plugin-abi-fixture/plugin.js", import.meta.url));
const PRIVATE_SERVER = "memory";

describe("private MCP admit", () => {
  beforeEach(() => resetLocalIDs());

  it("foreground_denied_bindings_narrow_tools_notify_needs_support", async () => {
    const definition = resolveReferences(
      normalizeDefinitions((await import(FIXTURE_PLUGIN)).default, "abi-fixture"),
      "abi-fixture",
    );
    const catalog = new KernelToolCatalog();
    await applyPackPlugins(catalog, [{ pluginName: "abi-fixture", module: (await import(FIXTURE_PLUGIN)).default }]);
    const state = catalog.pluginInstall;

    const scoutState = mergePluginInstallState([
      compilePluginInstall(
        "abi-fixture",
        {
          ...definition,
          bots: [
            {
              name: "scout",
              recipeScope: "invocation",
              instructions: prompt.system`read only`,
              mcp: [{ server: PRIVATE_SERVER, tools: ["find", "read"], approval: "allow" }],
            },
          ],
        },
        { [PRIVATE_SERVER]: ["find", "read", "commit"] },
      ),
    ]);
    const call = new BotCallJob({
      toolCallId: "t1",
      name: "fixture_bot_call",
      argsJson: JSON.stringify({ prompt: "x" }),
    });
    const callDoc = Plexus.bootstrap(call);
    onTestFinished(() => callDoc.destroy());
    const session = new SessionRoot({ sessionId: "caller", path: "/tmp" });
    session.agentCallbacks[call.uuid] = session.sessionId;
    const handler = new ToolCallHandler({ catalog });
    const notify = handler.admit(
      {
        id: "n1",
        type: "function",
        function: {
          name: "agent__notify",
          arguments: JSON.stringify({ requestId: call.uuid, message: "ping" }),
        },
      },
      catalog,
      { session, loadAgentCall: () => call },
    );
    expect({
      foreground: admitPrivateMcpTool(state, "", "abi-fixture", PRIVATE_SERVER, "commit"),
      workerFind: admitPrivateMcpTool(state, "worker", "abi-fixture", PRIVATE_SERVER, "find"),
      workerCommit: admitPrivateMcpTool(state, "worker", "abi-fixture", PRIVATE_SERVER, "commit"),
      scoutCommit: admitPrivateMcpTool(scoutState, "scout", "abi-fixture", PRIVATE_SERVER, "commit"),
      notifySupport: agentCallSupportsNotify(catalog, call.name),
      notify: {
        kind: notify instanceof AgentNotifyJob,
        completed: notify.completed,
        outcome: JSON.parse(notify.receiptJson ?? "{}"),
      },
    }).toEqual({
      foreground: expect.objectContaining({ allowed: false, reason: "foreground cannot call private MCP tools" }),
      workerFind: { allowed: true },
      workerCommit: expect.objectContaining({
        allowed: false,
        reason: `worker cannot use commit on ${PRIVATE_SERVER}`,
      }),
      scoutCommit: expect.objectContaining({ allowed: false }),
      notifySupport: false,
      notify: { kind: true, completed: true, outcome: expect.objectContaining({ ok: false }) },
    });
  });
});
