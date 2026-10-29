import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { resetLocalIDs } from "@here.build/plexus";
import { prompt } from "@inhuman.tools/harness-commons";
import {
  CompletionExpectation,
  CompletionJob,
  reactChunks,
  ReACTChunk,
  tapeCompletion,
  responseCall,
  SessionSystemPrompt,
  SessionTurn,
  SystemToolJob,
  ToolCallJob,
  CompactJob,
  parseCompactTrigger,
} from "@inhuman.tools/harness-model";
import { mkdtemp } from "fs-extra";
import { when } from "mobx";
import { expect, onTestFinished, test } from "vitest";

import { compactDue, MessageChunk, payloadSuffix, Transcript } from "@/context";
import { applyCompact } from "@/session";

import {
  useKeepFirstCompact,
  attachScriptedModel,
  modelOf,
  scriptedConnectionId,
} from "../../../testkit/scripted-model.js";
import { KernelDaemon } from "../../kernel/KernelDaemon.js";
import { ProjectDaemon } from "../../project/ProjectDaemon.js";
import type { SessionDaemon } from "../SessionDaemon.js";

const TIMEOUT = 2_000;

const starterPath = fileURLToPath(new URL("fixtures/compact-starter/compact.scm", import.meta.url));

test("compact cycle: occupancy, overflow insert, cutoff, pair-safety, later turn eats the card", async () => {
  resetLocalIDs();

  const pairC1 = completion("one", { used: 10, total: 100 });
  const pairT1 = tool("t1");
  const pairT2 = tool("t2", "Bash");
  const pairC2 = completion("two", { used: 10, total: 100 });
  const card = new MessageChunk("user", "prior card", { checkIn: true });
  const paired = Transcript.fromCells([card, pairC1, pairT1, pairT2, pairC2], 100, [card]);
  const toolLast = Transcript.fromCells([pairC1, pairT1], 100);
  const pairSafety = {
    last1: payloadSuffix(paired, 1),
    last2: payloadSuffix(paired, 2),
    last3: payloadSuffix(paired, 3),
    skipsCard: payloadSuffix(paired, 1).includes(card),
    toolLast: payloadSuffix(toolLast, 1),
  };

  const session = await openSession();
  const overflowTurn = new SessionTurn({ turnTail: new SessionSystemPrompt(), prompt: prompt.user`use echo` });
  session.root.head = overflowTurn;
  await when(() => completionsOf(overflowTurn).length === 1, { timeout: TIMEOUT });
  const first = completionsOf(overflowTurn)[0]!;
  first.totalTokens = 91;
  first.contextLimit = 100;
  const occupancy = [[parseCompactTrigger(""), compactDue(overflowTurn, parseCompactTrigger(""))]];
  modelOf(session).reply({ calls: [responseCall("call_1", "echo")] });
  await when(() => reactChunks(overflowTurn).some((chunk) => chunk instanceof ReACTChunk), { timeout: TIMEOUT });
  const firstTool = reactChunks(overflowTurn).find((chunk) => chunk instanceof ToolCallJob);
  if (firstTool == null) throw new Error("expected first tool");
  firstTool.receiptJson = JSON.stringify({ ok: true, text: "ok" });
  firstTool.humanApprove = false;
  await when(() => completionsOf(overflowTurn).length === 2, { timeout: TIMEOUT });
  const second = completionsOf(overflowTurn)[1]!;
  second.totalTokens = 91;
  second.contextLimit = 100;
  modelOf(session).reply({ calls: [responseCall("call_2", "echo")] });
  await when(() => reactChunks(overflowTurn).some((chunk) => chunk instanceof CompactJob), { timeout: TIMEOUT });
  const overflowTape = reactChunks(overflowTurn);
  const overflowTool = overflowTape.findLast((chunk) => chunk instanceof ToolCallJob);
  if (overflowTool == null) throw new Error("expected overflow tool");
  const overflowCompact = overflowTape.find((chunk) => chunk instanceof CompactJob);
  if (overflowCompact == null) throw new Error("expected overflow compact");
  const react = overflowTape.findLast((chunk) => chunk instanceof ReACTChunk);
  if (react == null) throw new Error("expected overflow react");
  const overflowInsert = {
    used: second.totalTokens,
    limit: second.contextLimit,
    compactAfterTool: overflowTape.indexOf(overflowCompact) === overflowTape.indexOf(overflowTool) + 1,
    reactAfterCompact: overflowTape.indexOf(react) === overflowTape.indexOf(overflowCompact) + 1,
  };
  overflowTool.receiptJson = JSON.stringify({ ok: true, text: "ok" });
  overflowTool.humanApprove = false;
  await when(() => completionsOf(overflowTurn).length === 3, { timeout: TIMEOUT });
  const folded = overflowTurn.doneWork.find((chunk) => chunk instanceof CompactJob)!;
  const nextMessages = completionsOf(overflowTurn)[2]!.messages;
  const overflowFold = {
    cutoff: folded.cutoff,
    failed: folded.failed,
    card: folded.standIn,
    keptSecond: nextMessages.includes(second),
    keptOverflowTool: nextMessages.includes(overflowTool),
    droppedFirstTool: !nextMessages.includes(firstTool),
    droppedFirstCompletion: !nextMessages.includes(first),
  };
  modelOf(session).reply({ text: "done" });
  await when(() => overflowTurn.reducerExited, { timeout: TIMEOUT });

  const platonicPrior = new CompletionExpectation({ connectionId: "c1" });
  platonicPrior.totalTokens = 20;
  platonicPrior.contextLimit = 100;
  platonicPrior.responseText = "prior";
  const platonicCall = new SystemToolJob({
    toolCallId: "t1",
    name: "echo",
    argsJson: "{}",
    outcomeJson: JSON.stringify({ ok: true, text: "ok" }),
  });
  const platonicMid = new CompletionExpectation({ connectionId: "c1" });
  platonicMid.totalTokens = 40;
  platonicMid.contextLimit = 100;
  platonicMid.responseText = "mid";
  const platonicLast = new CompletionExpectation({ connectionId: "c1" });
  platonicLast.totalTokens = 60;
  platonicLast.contextLimit = 100;
  platonicLast.responseText = "last";
  const platonic = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user`old`,
    doneWork: [
      new CompletionJob({ expectation: platonicPrior }),
      platonicCall,
      new CompletionJob({ expectation: platonicMid }),
      new CompletionJob({ expectation: platonicLast }),
    ],
    queue: [],
    reducerExited: true,
  });
  platonicMid.messages = [platonicPrior, platonicCall];
  platonicLast.messages = [platonicPrior, platonicCall, platonicMid];
  const compactChunk = new CompactJob({ reason: "user" });
  const foldedTurn = new SessionTurn({
    turnTail: platonic,
    prompt: prompt.user``,
    queue: [compactChunk],
  });
  session.root.head = foldedTurn;
  await when(() => foldedTurn.reducerExited, { timeout: TIMEOUT });
  const afterFold = new SessionTurn({ turnTail: foldedTurn, prompt: prompt.user`new` });
  session.root.head = afterFold;
  await when(() => completionsOf(afterFold).length === 1, { timeout: TIMEOUT });
  const successor = completionsOf(afterFold)[0]!.messages;
  const platonicEat = {
    reducerExited: foldedTurn.reducerExited,
    cutoff: compactChunk.cutoff,
    failed: compactChunk.failed,
    completions: completionsOf(foldedTurn).length,
    card: compactChunk.standIn,
    successorHasLast: successor.includes(platonicLast),
    successorHasFoldedTool: successor.includes(platonicCall),
    successorHasMidRef: successor.includes(platonicMid),
  };
  modelOf(session).reply({ text: "ok" });
  await when(() => afterFold.reducerExited, { timeout: TIMEOUT });

  expect({ pairSafety, occupancy, overflowInsert, overflowFold, platonicEat }).toEqual({
    pairSafety: {
      last1: [pairC2],
      last2: [pairC1, pairT1, pairT2, pairC2],
      last3: [pairC1, pairT1, pairT2, pairC2],
      skipsCard: false,
      toolLast: [pairC1, pairT1],
    },
    occupancy: [[null, false]],
    overflowInsert: { used: 91, limit: 100, compactAfterTool: true, reactAfterCompact: true },
    overflowFold: {
      cutoff: true,
      failed: false,
      card: "use echo",
      keptSecond: true,
      keptOverflowTool: true,
      droppedFirstTool: true,
      droppedFirstCompletion: true,
    },
    platonicEat: {
      reducerExited: true,
      cutoff: true,
      failed: false,
      completions: 0,
      card: "prior",
      successorHasLast: true,
      successorHasFoldedTool: false,
      successorHasMidRef: false,
    },
  });
}, 30_000);

test("require and .prompt pretreats resolve with sourcePath, unbound without it", async () => {
  resetLocalIDs();
  const eat = spine([20_000, 40_000], 100_000);
  // The on-disk strategy's first line is `(require "compact.prompt")`; the
  // loader is jailed under its dirname. Without sourcePath the symbol is
  // unbound and the compact degrades to the keep-first fallback.
  const unbound = await settle(applyCompact(readFileSync(starterPath, "utf8"), eat, eat));
  expect(unbound.ok).toBe(false);
  if (unbound.ok) throw new Error("expected require to be unbound without sourcePath");
  expect(unbound.message).toMatch(/Unbound variable `require'/);

  const loaded = await applyCompact(stubbedFromDisk(), eat, eat, { sourcePath: starterPath });
  expect(loaded.ok).toBe(true);
  if (!loaded.ok) throw new Error("strategy with sourcePath refused to load");
  const text = loaded.checkIn.map((cell) => (cell instanceof MessageChunk ? cell.text : "")).join("\n");
  expect(text).toContain("SNAPSHOT-BODY");
}, 10_000);

function settle(promise: Promise<unknown>): Promise<{ ok: false; message: string } | { ok: true; value: unknown }> {
  return promise.then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, message: error instanceof Error ? error.message : String(error) }),
  );
}

function stubbedFromDisk(): string {
  return readFileSync(starterPath, "utf8").replace(
    '(define summarize (require "compact.prompt"))',
    '(define (summarize . args) "SNAPSHOT-BODY")',
  );
}

function completion(
  promptText: string,
  opts: { used?: number; total?: number; response?: string } = {},
): CompletionExpectation {
  const minted = new CompletionExpectation({
    connectionId: "c1",
    promptText: prompt.user`${promptText}`,
  });
  minted.totalTokens = opts.used ?? 0;
  minted.contextLimit = opts.total ?? 100;
  minted.responseText = opts.response ?? "ok";
  return minted;
}

function tool(id: string, name = "Read"): SystemToolJob {
  return new SystemToolJob({
    toolCallId: id,
    name,
    argsJson: "{}",
    outcomeJson: JSON.stringify({ ok: true, text: "out" }),
  });
}

function spine(gauges: readonly number[], total = 100): Transcript {
  return Transcript.fromCells(
    gauges.map((used, i) => completion(i === 0 ? "task" : `turn-${i}`, { used, total, response: `r${i}` })),
    total,
  );
}

function completionsOf(turn: SessionTurn): CompletionExpectation[] {
  const out: CompletionExpectation[] = [];
  for (const chunk of reactChunks(turn)) {
    const pew = tapeCompletion(chunk);
    if (pew != null) out.push(pew);
  }
  return out;
}

async function openSession(): Promise<SessionDaemon> {
  const system = await mkdtemp(join(tmpdir(), "harness-compact-k-"));
  const workspace = await mkdtemp(join(tmpdir(), "harness-compact-p-"));
  const kernel = new KernelDaemon(system);
  await kernel.ready;
  useKeepFirstCompact(kernel, system);
  const project = new ProjectDaemon(kernel, workspace);
  await project.ready;
  const session = await project.session("s1");
  attachScriptedModel(kernel, session);
  onTestFinished(() => {
    session[Symbol.dispose]();
    project[Symbol.dispose]();
    kernel[Symbol.dispose]();
  });
  await session.handleRequest("kv/set", { key: "connection", value: scriptedConnectionId() });
  return session;
}
