/**
 * Step 2 plugin ABI installation and compile tests.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { resetLocalIDs } from "@here.build/plexus";
import { prompt } from "@inhuman.tools/harness-commons";
import {
  BotCallJob,
  CompletionExpectation,
  CompletionJob,
  responseCall,
  SessionSystemPrompt,
  SessionTurn,
  SuccessfulOutcome,
} from "@inhuman.tools/harness-model";
import { InhumanPlugin, InhumanTool, normalizeDefinitions, resolveReferences } from "@inhuman.tools/plugin-sdk";
import { isCallPaused } from "@inhuman.tools/turn/agent-calls";
import { mkdtemp } from "fs-extra";
import { when } from "mobx";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { z } from "zod";

import { usesGenericSilentProjection } from "@/context";
import { pluginContributionRevision } from "@/extensions";
import { chatContentText, viewWire } from "@/providers/openai-compat";

import { KernelDaemon } from "../daemon/kernel/KernelDaemon.js";
import { ProjectDaemon } from "../daemon/project/ProjectDaemon.js";
import { applyPackPlugins } from "../toolkit/actor.js";
import { compilePluginInstall } from "../toolkit/plugin-registry.js";
import { KernelToolCatalog } from "../toolkit/tool-table.js";

const FIXTURE_PLUGIN = fileURLToPath(
  new URL("../toolkit/__tests__/fixtures/plugin-abi-fixture/plugin.js", import.meta.url),
);
const OLD_SDK = fileURLToPath(new URL("../toolkit/__tests__/fixtures/old-sdk-fixture/plugin.js", import.meta.url));
const PLAIN = fileURLToPath(new URL("../toolkit/__tests__/fixtures/plain-object-fixture/plugin.js", import.meta.url));

async function installModule(moduleUrl: string, pluginName: string, catalog = new KernelToolCatalog()) {
  const mod = await import(moduleUrl);
  const report = await applyPackPlugins(catalog, [{ pluginName, module: mod.default ?? mod }]);
  return { catalog, report, module: mod };
}

function thrownMessage(run: () => void): string {
  try {
    run();
    return "did-not-throw";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function toolShape(tool: { type?: string; name?: string; class?: string } | undefined) {
  return { type: tool?.type, name: tool?.name, class: tool?.class };
}

describe("plugin ABI step 2", () => {
  beforeEach(() => resetLocalIDs());

  it("plain_ctor_old_sdk_match_and_exclusive_slot_conflict", async () => {
    const plain = normalizeDefinitions((await import(PLAIN)).default, "plain");
    const ctor = normalizeDefinitions(
      new InhumanPlugin({
        apiVersion: 1,
        tools: [
          new InhumanTool({
            name: "plain_echo",
            class: "read",
            input: z.object({ note: z.string().optional() }),
            output: z.object({ ok: z.boolean() }),
            run: () => ({ ok: true }),
          }),
        ],
      }),
      "ctor",
    );
    const old = normalizeDefinitions((await import(OLD_SDK)).default, "old");
    const { catalog: a } = await installModule(PLAIN, "plain-pack");
    const { catalog: b } = await installModule(OLD_SDK, "old-pack");
    expect({
      plain: toolShape(plain.tools[0]),
      ctor: toolShape(ctor.tools[0]),
      old: toolShape(old.tools[0]),
      packMeta: {
        plain: a.catalogEntry("plain_echo")?.packMeta,
        old: b.catalogEntry("old_ping")?.packMeta,
        workerCall: a.catalogEntry("call__worker__fixture_bot_call"),
      },
    }).toEqual({
      plain: { type: "function", name: "plain_echo", class: "read" },
      ctor: { type: "function", name: "plain_echo", class: "read" },
      old: { type: "function", name: "old_ping", class: "read" },
      packMeta: {
        plain: { kind: "function" },
        old: { kind: "function" },
        workerCall: undefined,
      },
    });

    const slotOne = { apiVersion: 1 as const, exclusiveSlots: ["slot-a"], tools: [] };
    const slotTwo = { apiVersion: 1 as const, exclusiveSlots: ["slot-a"], tools: [] };
    const sketch = compilePluginInstall("one", resolveReferences(normalizeDefinitions(slotOne, "one"), "one"), {});
    const catalog = new KernelToolCatalog();
    const report = await applyPackPlugins(catalog, [
      { pluginName: "one", module: slotOne },
      { pluginName: "two", module: slotTwo },
    ]);
    expect({
      exclusive: sketch.definition.exclusiveSlots.includes("slot-a"),
      conflict: report.errors.some((row) => row.includes("slot-a")),
      plugins: {
        named: catalog.pluginInstall.plugins.has("named-agents"),
        one: catalog.pluginInstall.plugins.has("one"),
        two: catalog.pluginInstall.plugins.has("two"),
      },
    }).toEqual({
      exclusive: true,
      conflict: true,
      plugins: { named: true, one: false, two: false },
    });

    const mod = await import(FIXTURE_PLUGIN);
    mod.resetFixtureSeen();
    const system = await mkdtemp(join(tmpdir(), "harness-abi-k-"));
    const workspace = await mkdtemp(join(tmpdir(), "harness-abi-p-"));
    const kernel = new KernelDaemon(system);
    await kernel.ready;
    await applyPackPlugins(kernel.catalog, [{ pluginName: "abi-fixture", module: mod }]);
    const project = new ProjectDaemon(kernel, workspace);
    await project.ready;
    const session = await project.session("caller");
    onTestFinished(() => {
      session[Symbol.dispose]();
      project[Symbol.dispose]();
      kernel[Symbol.dispose]();
    });
    expect({
      recipesHasWorker: kernel.catalog.recipes.some((recipe) => recipe.spec.name === "worker"),
      compiledHasWorker: kernel.catalog.compiledRecipes.some((recipe) => recipe.spec.name === "worker"),
      workerCategory: kernel.catalog.recipe("worker")?.category,
      quickSearchCategory: kernel.catalog.recipe("quick-search")?.category,
      authoredBots: Object.keys(kernel.plexus.root.bots),
    }).toEqual({
      recipesHasWorker: false,
      compiledHasWorker: true,
      workerCategory: "plugin",
      quickSearchCategory: "internal",
      authoredBots: [],
    });

    const completion = new CompletionExpectation({ connectionId: "c1", promptText: prompt.user`hi` });
    const call = new BotCallJob({
      toolCallId: "tc1",
      name: "fixture_bot_call",
      argsJson: JSON.stringify({ prompt: "needle" }),
      humanApprove: true,
    });
    const turn = new SessionTurn({ turnTail: new SessionSystemPrompt(), queue: [], reducerExited: true });
    turn.enqueue(new CompletionJob({ expectation: completion }));
    turn.enqueue(call);
    session.root.head = turn;
    await when(() => call.workerSessionId !== "" && mod.fixtureSeen().prompt === "needle", { timeout: 8_000 });
    const seen = mod.fixtureSeen();
    expect({
      seen: {
        prompt: seen.prompt,
        turn: seen.turn === turn,
        completion: seen.completion === completion,
        invocation: seen.invocation === call,
      },
      prepared: call.preparedInput,
      workerCall: kernel.catalog.catalogEntry("call__worker__fixture_bot_call"),
    }).toEqual({
      seen: { prompt: "needle", turn: true, completion: true, invocation: true },
      prepared: { preparedPrompt: "needle" },
      workerCall: undefined,
    });
  });

  it("disable_then_upgrade_keeps_accepted_call_blocked", async () => {
    expect({
      unknownTag: thrownMessage(() =>
        normalizeDefinitions(
          {
            apiVersion: 1,
            tools: [{ type: "bot-message", name: "nope", input: z.object({}), output: z.object({}) }],
          },
          "bad",
        ),
      ),
      dangling: thrownMessage(() =>
        resolveReferences(
          normalizeDefinitions(
            {
              apiVersion: 1,
              tools: [
                {
                  type: "bot-call",
                  name: "x",
                  target: "missing",
                  input: z.object({}),
                  output: z.object({}),
                },
              ],
            },
            "bad",
          ),
          "bad",
        ),
      ),
    }).toEqual({
      unknownTag: expect.stringMatching(/bot-message/),
      dangling: expect.stringMatching(/unresolved/),
    });

    const system = await mkdtemp(join(tmpdir(), "harness-abi-disable-k-"));
    const workspace = await mkdtemp(join(tmpdir(), "harness-abi-disable-p-"));
    const kernel = new KernelDaemon(system);
    await kernel.ready;
    const fixture = await import(FIXTURE_PLUGIN);
    await applyPackPlugins(kernel.catalog, [{ pluginName: "abi-fixture", module: fixture }]);
    const project = new ProjectDaemon(kernel, workspace);
    await project.ready;
    const session = await project.session("caller");
    onTestFinished(() => {
      session[Symbol.dispose]();
      project[Symbol.dispose]();
      kernel[Symbol.dispose]();
    });

    const installed = kernel.catalog.pluginInstall.plugins.get("abi-fixture")!;
    const pinnedRevision = pluginContributionRevision(installed);
    const call = new BotCallJob({
      toolCallId: "paused",
      name: "fixture_offload",
      argsJson: JSON.stringify({ guidance: "pause me" }),
      humanApprove: true,
      background: true,
      walkBoundary: true,
      contributionPluginName: "abi-fixture",
      contributionBotName: "worker",
      contributionRevision: pinnedRevision,
      acceptedAt: Date.now(),
      preparedInputJson: JSON.stringify({ preparedGuidance: "pause me" }),
      workerSessionId: "worker-paused",
    });
    const pauseTurn = new SessionTurn({ turnTail: new SessionSystemPrompt(), queue: [call], reducerExited: true });
    session.root.head = pauseTurn;

    await applyPackPlugins(kernel.catalog, []);
    const disabled = isCallPaused(call, kernel.catalog);

    await applyPackPlugins(kernel.catalog, [{ pluginName: "abi-fixture", module: fixture }]);
    const upgraded = new BotCallJob({
      toolCallId: "paused-upgraded",
      name: "fixture_offload",
      argsJson: JSON.stringify({ guidance: "pause me" }),
      humanApprove: true,
      background: true,
      walkBoundary: true,
      contributionPluginName: "abi-fixture",
      contributionBotName: "worker",
      contributionRevision: "different-revision",
      acceptedAt: Date.now(),
      preparedInputJson: JSON.stringify({ preparedGuidance: "pause me" }),
      workerSessionId: "worker-paused",
    });
    const resumed = new BotCallJob({
      toolCallId: "paused-resumed",
      name: "fixture_offload",
      argsJson: JSON.stringify({ guidance: "pause me" }),
      humanApprove: true,
      background: true,
      walkBoundary: true,
      contributionPluginName: "abi-fixture",
      contributionBotName: "worker",
      contributionRevision: pluginContributionRevision(kernel.catalog.pluginInstall.plugins.get("abi-fixture")!),
      acceptedAt: Date.now(),
      preparedInputJson: JSON.stringify({ preparedGuidance: "pause me" }),
      workerSessionId: "worker-paused",
    });
    expect({
      disabled,
      upgraded: isCallPaused(upgraded, kernel.catalog),
      resumed: isCallPaused(resumed, kernel.catalog),
    }).toEqual({
      disabled: true,
      upgraded: true,
      resumed: false,
    });

    const prior = new CompletionExpectation({ connectionId: "c1", promptText: prompt.user`q` });
    prior.setResponseCalls([responseCall("call_silent", "fixture_silent")]);
    const turn = new SessionTurn({ turnTail: new SessionSystemPrompt(), prompt: prompt.user`q`, queue: [] });
    const silent = new BotCallJob({
      toolCallId: "call_silent",
      name: "fixture_silent",
      argsJson: "{}",
      humanApprove: true,
      background: true,
      completed: true,
      outcome: new SuccessfulOutcome({ valueJson: JSON.stringify({ ok: true }) }),
      contributionPluginName: "abi-fixture",
      contributionBotName: "worker",
      contributionRevision: pluginContributionRevision(kernel.catalog.pluginInstall.plugins.get("abi-fixture")!),
    });
    const tip = new CompletionExpectation({ connectionId: "c1", promptText: prompt.user`next` });
    const priorJob = new CompletionJob({ expectation: prior });
    const tipJob = new CompletionJob({ expectation: tip });
    turn.enqueue(priorJob);
    turn.enqueue(silent);
    turn.enqueue(tipJob);
    turn.doneWork.push(...turn.queue.splice(0));
    session.root.head = turn;
    const wire = [...viewWire(tip)];
    const silentTool = wire.find((msg) => msg.role === "tool" && msg.tool_call_id === "call_silent");
    expect({
      silent: usesGenericSilentProjection(silent, kernel.catalog),
      wire: {
        toolCall: wire.some((msg) => msg.tool_calls?.some((tc) => tc.function.name === "fixture_silent")),
        silentResult: silentTool != null && chatContentText(silentTool.content) === "",
      },
    }).toEqual({
      silent: true,
      wire: { toolCall: true, silentResult: true },
    });
  }, 15_000);
});
