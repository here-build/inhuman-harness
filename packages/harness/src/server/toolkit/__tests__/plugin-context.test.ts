/**
 * Plugin graph context origin and source-cut digest.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Plexus, resetLocalIDs } from "@here.build/plexus";
import { prompt } from "@inhuman.tools/harness-commons";
import {
  BotCallJob,
  CompletionExpectation,
  CompletionJob,
  responseCall,
  SessionRoot,
  SessionSystemPrompt,
  SessionTurn,
  SystemToolJob,
} from "@inhuman.tools/harness-model";
import { InhumanPlugin, InhumanTool } from "@inhuman.tools/plugin-sdk";
import { mkdtemp } from "fs-extra";
import { when } from "mobx";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { z } from "zod";

import { agentCallSupportsNotify } from "@/tool-catalog";
import { ToolCallHandler, pluginCallContextOf } from "@/tool-runtime";

import { KernelDaemon } from "../../daemon/kernel/KernelDaemon.js";
import { ProjectDaemon } from "../../daemon/project/ProjectDaemon.js";
import { applyPackPlugins } from "../actor.js";
import { buildSourceCut, sourceCutCharLimit } from "../source-cut.js";
import { KernelToolCatalog } from "../tool-table.js";

const FIXTURE_PLUGIN = new URL("fixtures/plugin-abi-fixture/plugin.js", import.meta.url).href;
const TIMEOUT = 8000;

function sourceDigest(value: unknown): unknown {
  if (value == null || typeof value !== "object" || !("source" in value)) return undefined;
  const source = value.source;
  if (source == null || typeof source !== "object" || !("digest" in source)) return undefined;
  return source.digest;
}

const cutFixture = new InhumanPlugin({
  apiVersion: 1,
  bots: [{ name: "writer", recipeScope: "session", instructions: prompt.system`fixture writer` }],
  tools: [
    new InhumanTool({
      type: "bot-call",
      name: "retain",
      description: "fixture retain",
      target: "writer",
      input: z.object({ guidance: z.string().optional() }),
      output: z.object({ kind: z.literal("empty") }),
      prepare: (input, ctx) => ({
        guidance: input.guidance ?? "",
        source: ctx.source,
      }),
      background: true,
      lifetime: "call",
      show: "omit",
      supportsNotify: false,
    }),
  ],
});

describe("plugin graph context", () => {
  beforeEach(() => resetLocalIDs());

  it(
    "origin_is_exact_and_source_digest_survives_later_results",
    async () => {
      const catalog = new KernelToolCatalog();
      await applyPackPlugins(catalog, [{ pluginName: "abi-fixture", module: (await import(FIXTURE_PLUGIN)).default }]);

      const session = new SessionRoot({ sessionId: "ctx", path: "/tmp" });
      const inboundTurn = new SessionTurn({
        turnTail: session.head ?? new SessionSystemPrompt(),
        prompt: prompt.user`inbound`,
        inbound: true,
      });
      const inboundCall = new BotCallJob({
        toolCallId: "in1",
        name: "agent__send",
        argsJson: "{}",
      });
      inboundTurn.pushChild(inboundCall);
      session.head = inboundTurn;
      const inboundCtx = pluginCallContextOf(session, inboundCall);

      const completion = new CompletionExpectation({ connectionId: "c1", promptText: prompt.user`model` });
      const native = new SystemToolJob({ toolCallId: "sys1", name: "fixture_echo", argsJson: "{}" });
      const botCall = new BotCallJob({
        toolCallId: "bc1",
        name: "fixture_bot_call",
        argsJson: JSON.stringify({ prompt: "p" }),
      });
      const notifyCall = new BotCallJob({
        name: "fixture_bot_call",
      });
      const notifyDoc = Plexus.bootstrap(notifyCall);
      onTestFinished(() => notifyDoc.destroy());
      const turn = new SessionTurn({ turnTail: new SessionSystemPrompt(), queue: [], reducerExited: true });
      turn.enqueue(new CompletionJob({ expectation: completion }));
      turn.enqueue(native);
      turn.enqueue(botCall);
      session.head = turn;

      const nativeCtx = pluginCallContextOf(session, native);
      const nestedCtx = pluginCallContextOf(session, botCall);
      session.agentCallbacks[notifyCall.uuid] = session.sessionId;
      const handler = new ToolCallHandler({ catalog });
      const notify = handler.admit(
        {
          id: "n1",
          type: "function",
          function: {
            name: "agent__notify",
            arguments: JSON.stringify({ requestId: notifyCall.uuid, message: "x" }),
          },
        },
        catalog,
        { session, loadAgentCall: () => notifyCall },
      );
      expect({
        inbound: inboundCtx.completion ?? null,
        native: {
          turn: nativeCtx.turn === turn,
          completion: nativeCtx.completion === completion,
          invocation: nativeCtx.invocation === native,
        },
        nested: {
          turn: nestedCtx.turn === turn,
          completion: nestedCtx.completion === completion,
          invocation: nestedCtx.invocation === botCall,
        },
        notify: {
          supports: agentCallSupportsNotify(catalog, botCall.name),
          completed: notify.completed,
        },
      }).toEqual({
        inbound: null,
        native: { turn: true, completion: true, invocation: true },
        nested: { turn: true, completion: true, invocation: true },
        notify: { supports: false, completed: true },
      });

      const system = await mkdtemp(join(tmpdir(), "harness-cut-k-"));
      const workspace = await mkdtemp(join(tmpdir(), "harness-cut-p-"));
      const kernel = new KernelDaemon(system);
      await kernel.ready;
      const report = await applyPackPlugins(kernel.catalog, [{ pluginName: "cut-fixture", module: cutFixture }]);
      await when(() => kernel.catalog.catalogEntry("retain") != null, { timeout: TIMEOUT });
      const project = new ProjectDaemon(kernel, workspace);
      await project.ready;
      const cutSession = await project.session("caller");
      onTestFinished(() => {
        cutSession[Symbol.dispose]();
        project[Symbol.dispose]();
        kernel[Symbol.dispose]();
      });

      const cutHandler = new ToolCallHandler({ catalog: kernel.catalog });
      const pinnedEcho = new SystemToolJob({
        toolCallId: "tc-pinned",
        name: "echo",
        argsJson: JSON.stringify({ message: "pinned needle" }),
        humanApprove: true,
        completed: true,
        outcomeJson: JSON.stringify({ ok: true, text: "pinned needle" }),
      });
      const cutCompletion = new CompletionExpectation({
        connectionId: "c1",
        promptText: prompt.user`retain this unit`,
        responseCalls: [
          responseCall("tc-pinned", "echo", '{"message":"pinned needle"}'),
          responseCall("tc-retain", "retain", '{"guidance":"keep"}'),
          responseCall("tc-echo", "echo"),
        ],
      });
      cutCompletion.responseText = "assistant spoke";
      const cutTurn = new SessionTurn({ turnTail: new SessionSystemPrompt(), queue: [], reducerExited: true });
      cutTurn.enqueue(new CompletionJob({ expectation: cutCompletion }));
      cutTurn.enqueue(pinnedEcho);
      cutSession.root.head = cutTurn;

      const retain = cutHandler.admit(
        {
          id: "tc-retain",
          type: "function",
          function: { name: "retain", arguments: JSON.stringify({ guidance: "keep" }) },
        },
        kernel.catalog,
        { session: cutSession.root, originTurn: cutTurn },
      );
      if (!(retain instanceof BotCallJob)) throw new Error("expected BotCallJob");
      retain.humanApprove = true;
      cutTurn.enqueue(retain);
      const budget = sourceCutCharLimit("call");
      const cutAtAdmission = buildSourceCut(cutSession.root, cutCompletion, retain, "retain", retain.args, budget);
      const digestAtAdmission = cutAtAdmission.digest;
      await when(() => retain.acceptedAt != null && retain.preparedDocument, { timeout: TIMEOUT });

      const laterEcho = new SystemToolJob({
        toolCallId: "tc-echo",
        name: "echo",
        argsJson: "{}",
        humanApprove: true,
        completed: true,
        outcomeJson: JSON.stringify({ ok: true, text: "later sibling result" }),
      });
      cutTurn.enqueue(laterEcho);
      pinnedEcho.receiptJson = JSON.stringify({ ok: true, text: "mutated pinned needle" });
      const cutAfterMutation = buildSourceCut(cutSession.root, cutCompletion, retain, "retain", retain.args, budget);
      expect({
        errors: report.errors,
        admission: {
          pinned: cutAtAdmission.slices.some((row) => row.text.includes("pinned needle")),
          later: cutAtAdmission.slices.some((row) => row.text.includes("later sibling")),
        },
        accepted: retain.acceptedAt != null,
        prepared: sourceDigest(retain.preparedInput),
        afterMutation: {
          cutChanged: cutAfterMutation.digest !== digestAtAdmission,
          preparedHeld: sourceDigest(retain.preparedInput) === digestAtAdmission,
        },
      }).toEqual({
        errors: [],
        admission: { pinned: true, later: false },
        accepted: true,
        prepared: digestAtAdmission,
        afterMutation: { cutChanged: true, preparedHeld: true },
      });
    },
    TIMEOUT,
  );
});
