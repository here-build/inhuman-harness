/**
 * Turn admission identity survives reconstruction; context follows the
 * owning turn, not session head.
 */
import { resetLocalIDs } from "@here.build/plexus";
import { prompt } from "@inhuman.tools/harness-commons";
import { type WorkContainer } from "@inhuman.tools/plexus-expectations";
import { beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

import { documentRoot } from "../document-root.js";
import { evalProgramOf, findEvalTurnByRequestId, findTurnById, hostingTurnOf } from "../eval-context.js";
import { CompletionExpectation } from "../expectations/CompletionExpectation.js";
import { CompletionJob } from "../jobs/CompletionJob.js";
import { ProgrammaticJob } from "../jobs/ProgrammaticJob.js";
import { SystemToolJob } from "../jobs/SystemToolJob.js";
import { RegisteredToolsSet } from "../RegisteredToolsSet.js";
import { SessionPlexus } from "../SessionPlexus.js";
import type { SessionRoot } from "../SessionRoot.js";
import { SessionSystemPrompt } from "../SessionSystemPrompt.js";
import { SessionSystemPromptDerivation } from "../SessionSystemPromptDerivation.js";
import { SessionTurnEvalSpec } from "../turn/eval-spec.js";
import { ReACTChunk } from "../turn/react-chunk.js";
import { SessionTurn } from "../turn/session-turn.js";
import { systemPartsOf } from "../turn/system-parts.js";

function evalContextOfTurn(turn: SessionTurn) {
  const spec = turn.evalSpec;
  if (spec == null) return null;
  return {
    turn,
    program: evalProgramOf(turn),
    requestId: spec.requestId,
    permissionMode: spec.permissionMode,
    cancelRequested: turn.cancelRequested,
  };
}

function evalContextOfJob(root: SessionRoot, job: WorkContainer) {
  const turn = hostingTurnOf(root, job);
  return turn == null ? null : evalContextOfTurn(turn);
}

/** The `Agent.head` child edge reaches the session. */
function headOwned(turn: SessionTurn): boolean {
  return turn.parentField === "head" && turn.rootAncestor?.isRoot === true;
}

function replicaOf(owner: SessionPlexus): { readonly root: SessionPlexus["root"]; [Symbol.dispose](): void } {
  const doc = new Y.Doc({ guid: owner.doc.guid });
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(owner.doc));
  const plexus = SessionPlexus.connect(doc);
  return {
    get root() {
      return plexus.root;
    },
    [Symbol.dispose]() {
      plexus.destroy();
      doc.destroy();
    },
  };
}

describe("SessionTurn admission and reconstruction", () => {
  beforeEach(() => resetLocalIDs());

  it("skipped continuations survive reconstruction without reopening a finished turn", () => {
    const owner = SessionPlexus.create("skipped-continuation", "/tmp/skipped-continuation");
    try {
      expect(new ReACTChunk().skipped).toBe(false);
      const completion = new CompletionExpectation({ connectionId: "mock" });
      completion.succeed("settled", "", "null", { result: { text: "Done." } });
      owner.root.head = new SessionTurn({
        turnTail: new SessionSystemPrompt(),
        doneWork: [new CompletionJob({ expectation: completion }), new ReACTChunk({ openPage: true, skipped: true })],
        queue: [],
        reducerExited: true,
      });
      using replica = replicaOf(owner);
      expect(replica.root.head?.doneWork.at(-1)).toMatchObject({ skipped: true });
      expect(replica.root.head?.lastTurnIncomplete).toBe(false);
      expect(replica.root.head?.queuedContinuation).toBe(false);
    } finally {
      owner.destroy();
    }
  });

  it("eval fields reconstruct; context follows the owning turn", () => {
    const older = SessionPlexus.create("s-old", "/tmp/old");
    older.root.head = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user`hello`,
      queue: [],
    });
    using olderReplica = replicaOf(older);

    const evalPlexus = SessionPlexus.create("s-eval", "/tmp/eval");
    const program = new ProgrammaticJob({
      toolCallId: "program",
      argsJson: JSON.stringify({ expr: "(+ 1 2)" }),
      outcomeJson: JSON.stringify({ ok: false, text: "needs a person", code: "interaction_required" }),
    });
    const evalTurn = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user``,
      evalSpec: new SessionTurnEvalSpec({ requestId: "req-1", permissionMode: "auto" }),
      cancelRequested: true,
      queue: [program],
    });
    evalPlexus.root.head = evalTurn;
    const turnId = evalTurn.uuid;
    const programId = program.uuid;
    using evalReplica = replicaOf(evalPlexus);
    const found = findEvalTurnByRequestId(evalReplica.root, "req-1");
    const replicaProgram = found?.queue[0];

    const ctxPlexus = SessionPlexus.create("s-ctx", "/tmp/ctx");
    const inner = new SystemToolJob({ name: "bash" });
    const ctxProgram = new ProgrammaticJob({
      toolCallId: "program",
      argsJson: JSON.stringify({ expr: "(bash)" }),
    });
    ctxProgram.pushInvocation(inner);
    const owned = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user``,
      evalSpec: new SessionTurnEvalSpec({ requestId: "req-owned", permissionMode: "yolo" }),
      queue: [ctxProgram],
      reducerExited: true,
    });
    ctxPlexus.root.head = owned;
    ctxPlexus.root.head = new SessionTurn({
      turnTail: owned,
      prompt: prompt.user`interactive follow-up`,
      queue: [],
    });
    using ctxReplica = replicaOf(ctxPlexus);
    const replicaEval = findEvalTurnByRequestId(ctxReplica.root, "req-owned");
    const replicaInner = evalProgramOf(replicaEval!)?.toolCalls[0];
    const innerCtx = replicaInner ? evalContextOfJob(ctxReplica.root, replicaInner) : null;

    expect({
      older: {
        evalSpec: olderReplica.root.head?.evalSpec ?? null,
        cancelRequested: olderReplica.root.head?.cancelRequested,
        prompt: olderReplica.root.head?.prompt,
        cancelled: olderReplica.root.cancelledEvalRequests,
        context: evalContextOfTurn(olderReplica.root.head!),
      },
      identity: {
        found: found && findTurnById(evalReplica.root, turnId) === found,
        uuid: found?.uuid,
        cancelRequested: found?.cancelRequested,
        requestId: found?.evalSpec?.requestId,
        policy: found?.evalSpec?.permissionMode,
        program: replicaProgram instanceof ProgrammaticJob,
        programId: replicaProgram?.uuid,
        outcome: replicaProgram instanceof ProgrammaticJob ? replicaProgram.outcomeSnap : undefined,
      },
      afterHead: {
        headEval: ctxReplica.root.head?.evalSpec ?? null,
        headContext: evalContextOfTurn(ctxReplica.root.head!),
        inner: innerCtx && {
          requestId: innerCtx.requestId,
          permissionMode: innerCtx.permissionMode,
          cancelRequested: innerCtx.cancelRequested,
        },
        ownedId: replicaEval?.uuid,
      },
    }).toEqual({
      older: {
        evalSpec: null,
        cancelRequested: false,
        prompt: "hello",
        cancelled: {},
        context: null,
      },
      identity: {
        found: true,
        uuid: turnId,
        cancelRequested: true,
        requestId: "req-1",
        policy: "auto",
        program: true,
        programId,
        outcome: { ok: false, text: "needs a person", code: "interaction_required" },
      },
      afterHead: {
        headEval: null,
        headContext: null,
        inner: { requestId: "req-owned", permissionMode: "yolo", cancelRequested: false },
        ownedId: owned.uuid,
      },
    });
    older.destroy();
    evalPlexus.destroy();
    ctxPlexus.destroy();
  });

  it("connect hydrates leftover questionLine omitted from the session image", () => {
    const source = SessionPlexus.create("s-ql", "/tmp/ql");
    const turn = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user`hello`,
      queue: [],
      reducerExited: true,
    });
    source.root.head = turn;
    source.root.tip = turn;
    turn.questionLine = null as unknown as string;
    using replica = replicaOf(source);
    const head = replica.root.head;
    expect({
      questionLine: head instanceof SessionTurn ? head.questionLine : null,
      unfinished: replica.root.unfinished,
    }).toEqual({ questionLine: "", unfinished: "" });
    source.destroy();
  });

  it("connect adopts a head saved without a parent edge", () => {
    const source = SessionPlexus.create("s-reown", "/tmp/reown");
    const turn = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user`hello`,
      queue: [],
      reducerExited: true,
    });
    source.root.head = turn;
    source.root.tip = turn;
    turn.__yjsFieldsMap__?.clearParentData();
    using replica = replicaOf(source);
    const head = replica.root.head;
    expect({
      sourceLive: headOwned(turn),
      replica:
        head instanceof SessionTurn
          ? {
              live: headOwned(head),
              field: head.parentField,
              root: head.rootAncestor === replica.root,
              persisted: head.__yjsFieldsMap__?.hasParent === true,
            }
          : null,
    }).toEqual({
      sourceLive: false,
      replica: { live: true, field: "head", root: true, persisted: true },
    });
    source.destroy();
  });

  it("head owns the live turn and orphans the previous one", () => {
    const plexus = SessionPlexus.create("s-own", "/tmp/own");
    const prior = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user`prior`,
      queue: [],
      reducerExited: true,
    });
    const leaf = new SystemToolJob({ name: "echo" });
    prior.pushChild(leaf);
    plexus.root.head = prior;
    plexus.root.tip = prior;
    const head = new SessionTurn({
      turnTail: prior,
      prompt: prompt.user`head`,
      queue: [],
    });
    plexus.root.head = head;
    using replica = replicaOf(plexus);
    const replicaHead = replica.root.head;
    const replicaPrior = replicaHead instanceof SessionTurn ? replicaHead.turnTail : null;
    const owned = {
      live: headOwned(head) && head.rootAncestor === plexus.root,
      owner: head.parent?.constructor.name ?? null,
      recipeLink: head.parent?.parent ?? null,
    };
    plexus.root.enqueueAgentRequest("req", "caller", prompt.user`in`);
    const inbound = plexus.root.head;
    expect({
      owned,
      prior: { live: headOwned(prior), parent: prior.parent, tail: head.turnTail === prior },
      leaf: documentRoot(leaf) === plexus.root,
      replica: {
        live: replicaHead instanceof SessionTurn && headOwned(replicaHead) && replicaHead.rootAncestor === replica.root,
        priorLive: replicaPrior instanceof SessionTurn && headOwned(replicaPrior),
      },
      inbound: inbound instanceof SessionTurn && headOwned(inbound) && inbound !== head && !headOwned(head),
    }).toEqual({
      owned: { live: true, owner: "Agent", recipeLink: null },
      prior: { live: false, parent: null, tail: true },
      leaf: true,
      replica: { live: true, priorLive: false },
      inbound: true,
    });
    plexus.destroy();
  });

  it("connect leaves leftover pluginProblem omitted from the session image as null", () => {
    const source = SessionPlexus.create("s-pp", "/tmp/pp");
    source.root.pluginProblem = null;
    using replica = replicaOf(source);
    expect(replica.root.pluginProblem).toBeNull();
    source.destroy();
  });
});

describe("tail walks", () => {
  beforeEach(() => resetLocalIDs());

  it("fold the spine oldest first without recursing per turn", () => {
    const genesis = new SessionSystemPrompt({ constitution: prompt.system`base`, env: { cwd: "/a" } });
    const tools = new RegisteredToolsSet();
    let head = new SessionTurn({ turnTail: genesis, permissionMode: "auto", toolsDefinition: tools, queue: [] });
    const first = head;
    head.derivation = new SessionSystemPromptDerivation({ reason: "cwd changed", env: { cwd: "/b" } });
    for (let index = 0; index < 10_000; index += 1) head = new SessionTurn({ turnTail: head, queue: [] });
    head.derivation = new SessionSystemPromptDerivation({ reason: "date changed", env: { date: "today" } });
    const parts = systemPartsOf(head);
    expect({
      constitution: parts.constitution,
      env: parts.env,
      tools: head.tools === tools,
      mode: head.effectivePermissionMode,
      need: head.contextNeed,
      firstEnv: systemPartsOf(first).env,
    }).toEqual({
      constitution: "base",
      env: { cwd: "/b", date: "today" },
      tools: true,
      mode: "auto",
      need: null,
      firstEnv: { cwd: "/b" },
    });
  });

  it("end at a turnTail cycle", () => {
    const genesis = new SessionSystemPrompt();
    const a = new SessionTurn({ turnTail: genesis, queue: [] });
    const b = new SessionTurn({ turnTail: a, queue: [] });
    a.turnTail = b;
    expect({
      mode: b.effectivePermissionMode,
      need: b.contextNeed,
      metadata: b.metadata,
      tools: (() => {
        try {
          return b.tools;
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      })(),
    }).toEqual({ mode: "manual", need: null, metadata: null, tools: "turnTail cycle" });
  });
});
