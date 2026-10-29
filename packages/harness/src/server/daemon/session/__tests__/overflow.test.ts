import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetLocalIDs } from "@here.build/plexus";
import { prompt } from "@inhuman.tools/harness-commons";
import {
  CompletionExpectation,
  CompletionJob,
  reactChunks,
  SessionSystemPrompt,
  SessionTurn,
  CompactJob,
  TurnSteerChunk,
  parseCompactTrigger,
} from "@inhuman.tools/harness-model";
import { mkdtemp } from "fs-extra";
import { expect, test } from "vitest";

import { compactRejectReason, Transcript } from "@/context";
import { applyCompact } from "@/session";

import { KernelDaemon } from "../../kernel/KernelDaemon.js";
import { ProjectDaemon } from "../../project/ProjectDaemon.js";
import { loadCompactProgram } from "../compact.js";

const KEEP_FIRST = `
(define (compact compact-transcript full-transcript)
  (let ((xs (transcript/cells compact-transcript)))
    (if (null? xs) xs (list (car xs)))))
`;

test("compact refuse + RPC door; loadCompactProgram reads KernelRoot.compactStrategy", async () => {
  resetLocalIDs();

  const parsed = [
    ["90%", 0.9],
    ["80%", 0.8],
    ["0.75", 0.75],
    ["90", 0.9],
    ["", null],
    ["  ", null],
    ["0%", null],
    ["0", null],
    ["110%", null],
    ["nope", null],
  ] as const;
  const triggers = parsed.map(([input]) => [input, parseCompactTrigger(input)]);

  const prior = new CompletionExpectation({ connectionId: "c1" });
  const emptyTurn = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user``,
    queue: [new CompactJob()],
  });
  const folded = new CompactJob({ standIn: prior.responseText || "summary", completed: true });
  const compactTurn = new SessionTurn({
    turnTail: new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user`old`,
      doneWork: [new CompletionJob({ expectation: prior })],
      queue: [],
      reducerExited: true,
    }),
    prompt: prompt.user``,
    doneWork: [folded],
    queue: [],
    reducerExited: true,
  });
  const workSince = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user`hi`,
    doneWork: [new CompletionJob({ expectation: new CompletionExpectation({ connectionId: "c1" }) })],
    queue: [],
  });
  const steerOnly = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user``,
    doneWork: [
      new CompactJob({
        standIn: new CompletionExpectation({ connectionId: "c1" }).responseText || "summary",
        completed: true,
      }),
      new TurnSteerChunk({ text: prompt.user`keep going` }),
    ],
    queue: [],
  });
  const refuse = {
    emptyQueue: compactRejectReason(emptyTurn, emptyTurn.queue[0] as CompactJob),
    genesis: compactRejectReason(new SessionSystemPrompt()),
    compactOnCompact: compactRejectReason(compactTurn),
    workSinceFold: compactRejectReason(workSince),
    steerOnly: compactRejectReason(steerOnly),
  };

  const prefix = spine([20, 40], 100);
  const full = spine([20, 40, 50], 100);
  const unbound = await settleError(applyCompact("(this-name-is-not-bound)", prefix, full));
  const strategy = {
    emptyProgram: await settleError(applyCompact("", prefix, full)),
    unbound,
    unboundDefines: unbound.ok === false && /does not define/.test(unbound.message),
    missingDefine: await settleError(applyCompact("(define answer 42)", prefix, full)),
    emptyCard: await applyCompact(`(define (compact compact-transcript full-transcript) '())`, prefix, full),
    falseCard: await applyCompact(`(define (compact compact-transcript full-transcript) #f)`, prefix, full),
    emptyEat: await applyCompact(KEEP_FIRST, Transcript.empty(100), full),
    noShrink: await applyCompact(
      `(define (compact compact-transcript full-transcript)
         (list (message/user "${"x".repeat(200)}")))`,
      prefix,
      full,
    ),
  };

  using hosts = await fixture();
  const noHead = await hosts.session.handleRequest("compact", {});
  hosts.session.root.head = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user`hi`,
    queue: [],
    reducerExited: true,
  });
  const emptyEat = await hosts.session.handleRequest("compact", { focus: "keep" });
  const rpcPrior = new CompletionExpectation({ connectionId: "c1" });
  hosts.session.root.head = new SessionTurn({
    turnTail: new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user`old`,
      doneWork: [new CompletionJob({ expectation: rpcPrior })],
      queue: [],
      reducerExited: true,
    }),
    prompt: prompt.user``,
    doneWork: [new CompactJob({ standIn: rpcPrior.responseText || "summary", completed: true })],
    queue: [],
    reducerExited: true,
  });
  const compactOnCompact = await hosts.session.handleRequest("compact", { focus: "keep" });
  const admittedPrior = new CompletionExpectation({ connectionId: "c1" });
  admittedPrior.totalTokens = 80;
  admittedPrior.contextLimit = 100;
  admittedPrior.responseText = "hello there";
  const admitted = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user`hi`,
    doneWork: [new CompletionJob({ expectation: admittedPrior })],
    queue: [],
    reducerExited: true,
  });
  hosts.session.root.head = admitted;
  const minted = await hosts.session.handleRequest("compact", { focus: "keep" });
  const head = hosts.session.root.head;
  const tape = head instanceof SessionTurn ? reactChunks(head) : [];
  const rpc = {
    noHead,
    emptyEat,
    compactOnCompact,
    minted,
    turn: head instanceof SessionTurn,
    sameAsAdmitted: head === admitted,
    work: tape.filter((chunk) => chunk instanceof CompactJob).length,
    chunk: tape.find((chunk) => chunk instanceof CompactJob) ?? null,
    prompt: head instanceof SessionTurn ? head.prompt : "",
    turnTail: head instanceof SessionTurn ? head.turnTail : null,
  };

  const dir = await mkdtemp(join(tmpdir(), "harness-compact-spec-"));
  writeFileSync(join(dir, "mine.scm"), "(define (compact compact-transcript full-transcript) '(custom-card))\n");
  const loaded = {
    custom: loadCompactProgram("./mine.scm", dir).source.includes("custom-card"),
    dist: loadCompactProgram().source.includes("(define (compact"),
  };

  expect({ triggers, refuse, strategy, rpc, loaded }).toEqual({
    triggers: [...parsed],
    refuse: {
      emptyQueue: "empty",
      genesis: "empty",
      compactOnCompact: "already-compacted",
      workSinceFold: null,
      steerOnly: null,
    },
    strategy: {
      emptyProgram: { ok: false, message: "Invariant failed: compact strategy program is empty" },
      unbound: { ok: false, message: expect.stringMatching(/./) },
      unboundDefines: false,
      missingDefine: { ok: false, message: expect.stringMatching(/does not define compact/) },
      emptyCard: { ok: false, reason: "empty-check-in" },
      falseCard: { ok: false, reason: "empty-check-in" },
      emptyEat: { ok: false, reason: "empty-check-in" },
      noShrink: { ok: false, reason: "did-not-shrink" },
    },
    rpc: {
      noHead: { ok: false, reason: "no-head" },
      emptyEat: { ok: false, reason: "empty" },
      compactOnCompact: { ok: false, reason: "already-compacted" },
      minted: { ok: true, compacted: false },
      turn: true,
      sameAsAdmitted: false,
      work: 1,
      chunk: expect.any(CompactJob),
      prompt: "keep",
      turnTail: admitted,
    },
    loaded: { custom: true, dist: true },
  });
}, 20_000);

function spine(gauges: readonly number[], total = 100): Transcript {
  const cells = gauges.map((used, i) => {
    const minted = new CompletionExpectation({
      connectionId: "c1",
      promptText: i === 0 ? prompt.user`task` : prompt.user`turn-${i}`,
    });
    minted.totalTokens = used;
    minted.contextLimit = total;
    minted.responseText = `r${i}`;
    return minted;
  });
  return Transcript.fromCells(cells, total);
}

async function settleError(
  promise: Promise<unknown>,
): Promise<{ ok: false; message: string } | { ok: true; value: unknown }> {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

type Hosts = {
  kernel: KernelDaemon;
  project: ProjectDaemon;
  session: Awaited<ReturnType<ProjectDaemon["session"]>>;
  [Symbol.dispose](): void;
};

async function fixture(): Promise<Hosts> {
  const system = await mkdtemp(join(tmpdir(), "harness-compact-rpc-k-"));
  const workspace = await mkdtemp(join(tmpdir(), "harness-compact-rpc-p-"));
  const kernel = new KernelDaemon(system);
  await kernel.ready;
  const project = new ProjectDaemon(kernel, workspace);
  await project.ready;
  return {
    kernel,
    project,
    session: await project.session("s1"),
    [Symbol.dispose](): void {
      project[Symbol.dispose]();
      kernel[Symbol.dispose]();
    },
  };
}
