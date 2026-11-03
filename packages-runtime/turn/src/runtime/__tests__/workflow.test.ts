import {
  CompletionJob,
  ReACTChunk,
  RegisteredToolsSet,
  responseCall,
  SessionPlexus,
  SessionTurn,
  SystemToolJob,
  ToolSpec,
} from "@inhuman.tools/harness-model/session";
import { expect, it, onTestFinished } from "vitest";
import { z } from "zod";

import { projectHistory, type HistoryMessage } from "../../context/history.js";
import { admitTurn } from "../../session/commands.js";
import { bindSessionCatalog, KernelToolCatalog } from "../../tool-catalog/catalog.js";
import { ToolCallHandler } from "../../tool-runtime/handler.js";
import { executeSystemTool } from "../../tool-runtime/run-system-tool.js";
import { iterateTurn, type TurnIteratorHost } from "../index.js";

it("admits a supplied tool and waits for its actual receipt before the successor request", async () => {
  const plexus = SessionPlexus.create("embedded-turn");
  const catalog = new KernelToolCatalog();
  onTestFinished(() => {
    catalog[Symbol.dispose]();
    plexus.destroy();
  });
  const effects: string[] = [];
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  catalog.replacePack([
    {
      wireName: "echo",
      description: "Echo a message",
      parameters: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
      class: "read",
      representation: "tool",
      source: { kind: "pack", pluginName: "embedded-host" },
      execute: async (raw) => {
        const input = z.object({ message: z.string() }).parse(raw);
        effects.push(input.message);
        entered.resolve();
        await release.promise;
        return { ok: true, text: `echo:${input.message}` };
      },
    },
  ]);
  const session = plexus.root;
  bindSessionCatalog(session, catalog);
  session.applyKvs([
    { form: "kv-set", key: "connection", value: "supplied-model" },
    { form: "kv-set", key: "model", value: "scripted" },
  ]);
  const admitted = admitTurn(
    {
      session,
      constitution: "Use the supplied host capabilities.",
      env: () => ({}),
      toolsFor: () => new RegisteredToolsSet({ entries: [new ToolSpec({ name: "echo", argsJson: "{}" })] }),
      queuedVerbs: () => new Set(),
      cancelOwned: () => {},
    },
    { prompt: "Echo hello" },
  );
  if (!admitted.ok || !(session.head instanceof SessionTurn)) throw new Error("Turn admission failed");
  const turn = session.head;
  const handler = new ToolCallHandler({ catalog });
  const requests: HistoryMessage[][] = [];
  const host: TurnIteratorHost = {
    session,
    notes: { peek: () => [], consume: () => {} },
    compactKeepTurns: 1,
    hardCompactTrigger: "",
    admit: (call) => handler.admit(call, catalog, { session, originTurn: turn }),
    waitInbound: async () => true,
    openRound: async () => true,
    closeRound: async () => {},
    classifyIntent: async () => ({ verdict: null, status: "unconfigured", detail: "" }),
    startAmbientCompact: () => {},
    resolvers: {
      completion: async (job) => {
        const expectation = job.expectation;
        requests.push([...projectHistory(expectation)]);
        if (requests.length === 1)
          expectation.responseCalls.push(responseCall("echo-1", "echo", '{"message":"hello"}'));
        else expectation.responseText = "The host echoed hello.";
        expectation.succeed("settled", "scripted", "null");
      },
      work: async (job, signal) => {
        if (!(job instanceof SystemToolJob)) throw new TypeError("Unexpected host capability");
        await executeSystemTool(job, signal);
        job.markComplete();
        return "settled";
      },
      compact: async () => {
        throw new Error("Compaction was not requested");
      },
    },
  };
  const running = iterateTurn(turn, host, new AbortController().signal);
  await entered.promise;
  expect({
    effects,
    requests: requests.length,
    completed: turn.children.some((job) => job instanceof SystemToolJob && job.completed),
  }).toEqual({ effects: ["hello"], requests: 1, completed: false });
  release.resolve();
  await running;
  const tool = turn.children.find((job) => job instanceof SystemToolJob);
  expect({
    effects,
    receipt: tool?.outcomeSnap,
    successorToolMessages: requests[1]?.filter((message) => message.role === "tool"),
    decisions: turn.doneWork.filter((cell) => cell instanceof ReACTChunk).map((cell) => cell.decision?.kind),
    responses: turn.doneWork
      .filter((cell) => cell instanceof CompletionJob)
      .map((cell) => cell.expectation.responseText),
  }).toEqual({
    effects: ["hello"],
    receipt: { ok: true, text: "echo:hello" },
    successorToolMessages: [{ role: "tool", content: "echo:hello", toolCallId: "echo-1" }],
    decisions: ["advance", "halt"],
    responses: ["", "The host echoed hello."],
  });
});
