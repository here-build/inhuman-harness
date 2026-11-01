import { readFileSync } from "node:fs";
import { join } from "node:path";

import { prompt } from "@inhuman.tools/harness-commons";
import {
  admitSteer,
  CompactJob,
  CompletionJob,
  ProgrammaticJob,
  decideRound,
  ResponseCall,
  responseCall,
  SessionPlexus,
  SessionTurn,
  ToolCallJob,
} from "@inhuman.tools/harness-model";
import { expect, onTestFinished, test } from "vitest";
import * as Y from "yjs";

import {
  boundaries,
  configureJudge,
  liveSession,
  replicaOf,
  rounds,
  startTurn,
  wait,
} from "./fixtures/live-continuation.js";

const decision = (turn: SessionTurn) => boundaries(turn).at(-1)?.decision;
const toolJobs = (turn: SessionTurn) => turn.children.filter((job): job is ToolCallJob => job instanceof ToolCallJob);

test("arbitration defaults to halt and unions eligible causes independently of order and gates", () => {
  const candidates = [
    { cause: { kind: "input" as const, sources: ["steer"] } },
    { cause: { kind: "thought-repair" as const, sources: ["round"] }, budget: { used: 8, limit: 8 } },
    { cause: { kind: "plugin" as const, sources: ["note"] } },
  ];
  const permutations = <T>(rows: readonly T[]): T[][] =>
    rows.length === 0
      ? [[]]
      : rows.flatMap((row, index) => permutations(rows.filter((_, i) => i !== index)).map((tail) => [row, ...tail]));
  expect({
    empty: decideRound([]).kind,
    permutations: permutations(candidates).map((order) => {
      const result = decideRound(order);
      return {
        kind: result.kind,
        causes: result.causes.map((cause) => cause.kind).sort(),
        exhausted: result.assessments.filter((item) => item.disposition === "exhausted").map((item) => item.cause.kind),
      };
    }),
    gated: decideRound(candidates, { reason: "round-limit", detail: "limit" }),
  }).toMatchObject({
    empty: "halt",
    permutations: Array.from({ length: 6 }, () => ({
      kind: "advance",
      causes: ["input", "plugin"],
      exhausted: ["thought-repair"],
    })),
    gated: { kind: "blocked", reason: "round-limit", causes: [{ kind: "input" }, { kind: "plugin" }] },
  });
});

test("a settled tool, input and activating note authorize one successor; ambient context only enriches", async () => {
  const live = await liveSession();
  const { turn } = await startTurn(live);
  const notes = live.kernel.behavior.notes;
  notes.emit({
    agentId: live.session.sessionId,
    turnId: turn.uuid,
    mode: "ambient",
    boundary: "round-end",
    message: "Background context",
  });
  notes.emit({
    agentId: live.session.sessionId,
    turnId: turn.uuid,
    mode: "activating",
    boundary: "round-end",
    message: "Verify the result",
  });
  admitSteer(live.session.root, prompt.user`also check this`, turn.uuid);
  live.model.reply({ calls: [responseCall("files", "list_dir", '{"path":"."}')] });
  await wait(() => rounds(turn).length === 2);
  expect({
    work: toolJobs(turn).map((job) => ({ id: job.toolCallId, completed: job.completed, ok: job.outcomeSnap?.ok })),
    causes: boundaries(turn)[0]
      ?.decision?.causes.map((cause) => cause.kind)
      .sort(),
    successor: boundaries(turn)[0]?.decision?.nextRoundId,
    rounds: rounds(turn).length,
    note: rounds(turn)[1]?.expectation.systemNote,
    inbox: live.session.root.steerQueue.length,
  }).toEqual({
    work: [{ id: "files", completed: true, ok: true }],
    causes: ["input", "observation", "plugin"],
    successor: rounds(turn)[1]?.uuid,
    rounds: 2,
    note: "Background context\n\nVerify the result",
    inbox: 0,
  });
  notes.emit({
    agentId: live.session.sessionId,
    turnId: turn.uuid,
    mode: "ambient",
    boundary: "round-end",
    message: "No additional work",
  });
  live.model.reply({ text: "Done." });
  await wait(() => turn.reducerExited);
  const replica = replicaOf(live.session);
  const restored = replica.root.head as SessionTurn;
  expect({
    rounds: rounds(restored).length,
    decision: decision(restored)?.kind,
    incomplete: restored.lastTurnIncomplete,
  }).toEqual({ rounds: 2, decision: "halt", incomplete: false });
});

test("new input arriving during a final-answer judgment survives the awaited detector", async () => {
  const live = await liveSession();
  await configureJudge(live);
  let release!: () => void;
  live.model.judge({
    text: '{"intent":false,"awaiting_user":false}',
    gate: new Promise<void>((resolve) => {
      release = resolve;
    }),
  });
  const { turn } = await startTurn(live);
  live.model.reply({ text: "Done." });
  await wait(() =>
    turn.children.some(
      (job) => job instanceof CompletionJob && job.expectation.completionMode === "isolated" && !job.completed,
    ),
  );
  const waiting = replicaOf(live.session);
  expect({ exited: (waiting.root.head as SessionTurn).reducerExited, unfinished: waiting.root.unfinished }).toEqual({
    exited: false,
    unfinished: "turn",
  });
  await live.session.handleRequest("turn", { prompt: "check this too", kind: "steer" });
  release();
  await wait(() => rounds(turn).length === 2);
  expect({
    causes: boundaries(turn)[0]?.decision?.causes.map((cause) => cause.kind),
    intent: boundaries(turn)[0]?.decision?.intent?.verdict,
    successor: boundaries(turn)[0]?.decision?.nextRoundId,
  }).toEqual({ causes: ["input"], intent: "seal", successor: rounds(turn)[1]?.uuid });
  live.model.reply({ text: "Also done." });
  await wait(() => turn.reducerExited);
});

test.each(["cancel", "rewind"] as const)("%s prevents a late judge from admitting stale work", async (ending) => {
  const live = await liveSession();
  await configureJudge(live);
  let release!: () => void;
  let prior: SessionTurn | null = null;
  if (ending === "rewind") {
    prior = (await startTurn(live, "earlier request")).turn;
    live.model.reply({ text: "Earlier done." });
    await wait(() => prior!.reducerExited);
  }
  const { turn } = await startTurn(live);
  if (prior != null) turn.turnTail = prior;
  live.model.judge({
    text: '{"intent":true,"awaiting_user":false}',
    ignoreAbort: true,
    gate: new Promise<void>((resolve) => {
      release = resolve;
    }),
  });
  live.model.reply({ text: "I will edit now." });
  await wait(() =>
    turn.children.some(
      (job) => job instanceof CompletionJob && job.expectation.completionMode === "isolated" && !job.completed,
    ),
  );
  if (ending === "cancel") await live.session.handleRequest("turn/cancel", { turnId: turn.uuid });
  else {
    live.session.root.tip = turn;
    await live.session.handleRequest("turn/rewind", { turnId: prior!.uuid });
  }
  release();
  await wait(() => turn.reducerExited);
  // Flush and a fresh replica make a late completion observable without timing sleeps.
  const plexus = await live.kernel.acquireSession(live.session.sessionId);
  await live.kernel.flushSession(plexus!);
  expect({
    rounds: rounds(turn).length,
    successors: boundaries(turn).map((cell) => cell.decision?.nextRoundId ?? null),
    cancelled: turn.cancelled,
  }).toEqual({ rounds: 1, successors: [null], cancelled: true });
});

test.each([
  {
    name: "rejected calls",
    kind: "call-repair",
    reply: (index: number) => ({
      calls: [
        new ResponseCall({ toolCallId: `bad-${index}`, name: "write_file", argsJson: "{}", dropReason: "truncated" }),
      ],
    }),
  },
  {
    name: "failed observations",
    kind: "observation",
    reply: (index: number) => ({
      calls: [responseCall(`missing-${index}`, "read_file", '{"path":"does-not-exist.txt"}')],
    }),
  },
])("$name spend a bounded repair allowance without impersonating progress", async (row) => {
  const live = await liveSession();
  const { turn } = await startTurn(live);
  for (let index = 0; index < 5; index += 1) {
    live.model.reply(row.reply(index));
    await wait(() => (index < 4 ? rounds(turn).length === index + 2 : turn.reducerExited));
  }
  const replica = replicaOf(live.session);
  const restored = replica.root.head as SessionTurn;
  expect({
    rounds: rounds(restored).length,
    work: toolJobs(restored).map((job) => ({ completed: job.completed, ok: job.outcomeSnap?.ok })),
    final: decision(restored),
    incomplete: restored.lastTurnIncomplete,
  }).toMatchObject({
    rounds: 5,
    work: Array.from({ length: 5 }, () => ({ completed: true, ok: false })),
    final: {
      kind: "halt",
      reason: "trigger-budget",
      assessments: [{ cause: { kind: row.kind }, disposition: "exhausted", budget: { used: 4, limit: 4 } }],
    },
    incomplete: true,
  });
});

test("a round limit preserves the triggering work and replica-visible incomplete state", async () => {
  const live = await liveSession();
  live.kernel.plexus.root.maxRounds = 1;
  const { turn } = await startTurn(live);
  live.model.reply({ calls: [responseCall("files", "list_dir", '{"path":"."}')] });
  await wait(() => turn.reducerExited);
  const replica = replicaOf(live.session);
  const restored = replica.root.head as SessionTurn;
  expect({
    final: decision(restored),
    rounds: rounds(restored).length,
    incomplete: restored.lastTurnIncomplete,
    unfinished: replica.root.unfinished,
  }).toMatchObject({
    final: { kind: "blocked", reason: "round-limit", causes: [{ kind: "observation" }], nextRoundId: null },
    rounds: 1,
    incomplete: true,
    unfinished: "",
  });
});

test("successful work resets repair allowances; switching repair kind does not", async () => {
  const live = await liveSession();
  const { turn } = await startTurn(live);
  const rejected = (id: string) => ({
    calls: [new ResponseCall({ toolCallId: id, name: "write_file", argsJson: "{}", dropReason: "truncated" })],
  });
  const trace = [
    ...Array.from({ length: 4 }, (_, i) => rejected(`before-${i}`)),
    { calls: [responseCall("progress", "list_dir", '{"path":"."}')] },
    ...Array.from({ length: 4 }, (_, i) => rejected(`after-${i}`)),
    { thought: "still planning" },
    rejected("after-switch"),
  ];
  for (const [index, reply] of trace.entries()) {
    live.model.reply(reply);
    await wait(() => (index < trace.length - 1 ? rounds(turn).length === index + 2 : turn.reducerExited));
    if (index === 5) expect(boundaries(turn).at(-1)?.decision?.assessments[0]?.budget).toEqual({ used: 0, limit: 4 });
  }
  expect({ rounds: rounds(turn).length, final: decision(turn) }).toMatchObject({
    rounds: 11,
    final: {
      kind: "halt",
      reason: "trigger-budget",
      assessments: [{ cause: { kind: "call-repair" }, budget: { used: 4, limit: 4 }, disposition: "exhausted" }],
    },
  });
});

test("CodeAct executes through the real runtime and obeys its declared follow-up contract", async () => {
  const live = await liveSession();
  live.kernel.catalog.packEntries = live.kernel.catalog.packEntries.map((entry) =>
    entry.wireName === "scheme_repl" ? { ...entry, triggersReactLoop: false } : entry,
  );
  const { turn } = await startTurn(live);
  live.model.reply({
    text: "Done.",
    calls: [responseCall("program", "scheme_repl", JSON.stringify({ expr: "(+ 1 2)" }))],
  });
  await wait(() => turn.reducerExited);
  const program = turn.children.find((job): job is ProgrammaticJob => job instanceof ProgrammaticJob);
  expect({
    rounds: rounds(turn).length,
    completed: program?.completed,
    result: program?.resultText(),
    follows: program?.triggersReactLoop,
    decision: decision(turn)?.kind,
  }).toEqual({ rounds: 1, completed: true, result: "3", follows: false, decision: "halt" });
});

// These are real persisted prefixes of one production turn, observed at every Y update.
// Restart loads the prefix through DocumentService and the normal daemon recovery path.
test("all persisted response/decision/admission cuts recover once and remain stable across repeated restarts", async () => {
  const live = await liveSession(undefined, { "effect.txt": "seed" });
  live.session.root.permissionMode = "yolo";
  const { turn } = await startTurn(live);
  const source = rounds(turn)[0]!;
  const images = new Map<string, { image: Uint8Array; effect: string }>();
  const violations: unknown[] = [];
  const capture = (): void => {
    const image = Y.encodeStateAsUpdate(live.session.root.__doc__!);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, image);
    const view = SessionPlexus.connect(doc, { undo: "stub" });
    try {
      const saved = view.root.head as SessionTurn;
      const tape = [...saved.doneWork, ...saved.queue];
      const savedSource = rounds(saved).find((job) => job.uuid === source.uuid)!;
      for (const job of rounds(saved)) {
        if (job.responseWork.some((work) => !tape.includes(work)))
          violations.push({ cursor: "work-without-queue", job: job.uuid });
        if (job.responseExpanded && !boundaries(saved).some((boundary) => boundary.source === job))
          violations.push({ cursor: "expanded-without-boundary", job: job.uuid });
      }
      for (const boundary of boundaries(saved)) {
        const next = boundary.decision?.nextRoundId;
        if (next != null && !rounds(saved).some((job) => job.uuid === next))
          violations.push({ cursor: "edge-without-successor", next });
        if (boundary.source != null) {
          const sourceIndex = tape.indexOf(boundary);
          const nextJob = tape.slice(sourceIndex + 1).find((cell) => cell instanceof CompletionJob);
          if (nextJob != null && next !== nextJob.uuid)
            violations.push({ cursor: "successor-without-edge", boundary: boundary.uuid });
        }
      }
      const boundary = boundaries(saved).find((cell) => cell.source === savedSource);
      const phase =
        savedSource.expectation.outcome === "successful" && !savedSource.responseExpanded
          ? savedSource.responseWork.length === 0
            ? "provider-settled"
            : "metadata-recorded"
          : boundary?.decision == null && boundary != null
            ? "boundary-undecided"
            : boundary?.decision?.kind === "advance" && boundary.decision.nextRoundId == null
              ? "decision-recorded"
              : boundary?.decision?.nextRoundId != null && rounds(saved).length === 2 && !rounds(saved)[1]!.orchestrated
                ? "successor-recorded"
                : null;
      if (phase != null && !images.has(phase))
        images.set(phase, { image, effect: readFileSync(join(live.project.path, "effect.txt"), "utf8") });
    } finally {
      view.destroy();
    }
  };
  const doc = live.session.root.__doc__!;
  doc.on("update", capture);
  onTestFinished(() => doc.off("update", capture));
  live.model.reply({
    calls: [
      responseCall("title", "update_metadata", '{"current_turn_title":"Inspect"}'),
      responseCall("effect", "edit_file", '{"path":"effect.txt","old_string":"seed","new_string":"seed\\nhit"}'),
    ],
  });
  await wait(() => rounds(turn).length === 2);
  live.model.reply({ text: "Done." });
  await wait(() => turn.reducerExited);
  doc.off("update", capture);
  expect({ violations, cuts: [...images.keys()].sort() }).toEqual({
    violations: [],
    cuts: ["boundary-undecided", "decision-recorded", "metadata-recorded", "provider-settled", "successor-recorded"],
  });
  for (const [phase, { image, effect }] of images) {
    const recovered = await liveSession(image, { "effect.txt": effect }, live.project.path);
    recovered.model.reply({ text: "Recovered answer." });
    const resumed = recovered.session.root.head as SessionTurn;
    await wait(() => resumed.reducerExited);
    expect({
      phase,
      rounds: rounds(resumed).length,
      tools: toolJobs(resumed).map((job) => job.toolCallId),
      successor: boundaries(resumed)[0]?.decision?.nextRoundId,
      first: rounds(resumed)[0]?.expectation.outcome,
    }).toEqual({
      phase,
      rounds: 2,
      tools: ["title", "effect"],
      successor: rounds(resumed)[1]?.uuid,
      first: "successful",
    });
    expect({ phase, effect: readFileSync(join(recovered.project.path, "effect.txt"), "utf8") }).toEqual({
      phase,
      effect: "seed\nhit",
    });
    let stableImage = Y.encodeStateAsUpdate(recovered.session.root.__doc__!);
    const identities = rounds(resumed).map((job) => job.uuid);
    for (let restart = 0; restart < 2; restart += 1) {
      const restarted = await liveSession(stableImage, { "effect.txt": "seed\nhit" }, live.project.path);
      const final = restarted.session.root.head as SessionTurn;
      expect({
        phase,
        exited: final.reducerExited,
        rounds: rounds(final).map((job) => job.uuid),
        tools: toolJobs(final).map((job) => job.toolCallId),
      }).toEqual({ phase, exited: true, rounds: identities, tools: ["title", "effect"] });
      expect(readFileSync(join(restarted.project.path, "effect.txt"), "utf8")).toBe("seed\nhit");
      stableImage = Y.encodeStateAsUpdate(restarted.session.root.__doc__!);
    }
  }
}, 40_000);

test("repeated restarts abandon each interrupted provider attempt and grant one fresh successor", async () => {
  let live = await liveSession();
  const { turn } = await startTurn(live);
  let current = turn;
  const abandoned: string[] = [];
  for (let restart = 0; restart < 2; restart += 1) {
    await wait(() => rounds(current).at(-1)?.orchestrated === true);
    abandoned.push(rounds(current).at(-1)!.uuid);
    const image = Y.encodeStateAsUpdate(live.session.root.__doc__!);
    live = await liveSession(image, {}, live.project.path);
    current = live.session.root.head as SessionTurn;
    await wait(() => rounds(current).length === restart + 2);
    expect({
      attempts: rounds(current).length,
      failed: rounds(current)
        .slice(0, -1)
        .map((job) => job.expectation.outcome),
      grants: boundaries(current).map((cell) => ({
        cause: cell.decision?.causes,
        successor: cell.decision?.nextRoundId,
      })),
    }).toEqual({
      attempts: restart + 2,
      failed: Array.from({ length: restart + 1 }, () => "failed"),
      grants: abandoned.map((id, index) => ({
        cause: [{ kind: "recovery", sources: [id] }],
        successor: rounds(current)[index + 1]!.uuid,
      })),
    });
  }
  live.model.reply({ text: "Recovered answer." });
  await wait(() => current.reducerExited);
  const replica = replicaOf(live.session);
  const final = replica.root.head as SessionTurn;
  expect({ rounds: rounds(final).length, final: decision(final)?.kind, incomplete: final.lastTurnIncomplete }).toEqual({
    rounds: 3,
    final: "halt",
    incomplete: false,
  });
});

test("a forced compaction and its expansion boundary survive the same durable cut without duplicating the compact", async () => {
  const live = await liveSession(undefined, {}, undefined, true);
  const { turn } = await startTurn(live);
  const source = rounds(turn)[0]!;
  let image: Uint8Array | null = null;
  let compactId = "";
  const violations: string[] = [];
  const doc = live.session.root.__doc__!;
  const capture = (): void => {
    const snapshot = Y.encodeStateAsUpdate(doc);
    const replicaDoc = new Y.Doc();
    Y.applyUpdate(replicaDoc, snapshot);
    const replica = SessionPlexus.connect(replicaDoc, { undo: "stub" });
    try {
      const saved = replica.root.head as SessionTurn;
      const compact = [...saved.doneWork, ...saved.queue].find(
        (cell): cell is CompactJob => cell instanceof CompactJob,
      );
      if (compact == null) return;
      const savedSource = rounds(saved).find((job) => job.uuid === source.uuid)!;
      if (!savedSource.responseExpanded || !boundaries(saved).some((cell) => cell.source === savedSource))
        violations.push(compact.uuid);
      if (image == null && !compact.completed) {
        image = snapshot;
        compactId = compact.uuid;
      }
    } finally {
      replica.destroy();
    }
  };
  doc.on("update", capture);
  onTestFinished(() => doc.off("update", capture));
  live.model.reply({
    usage: { totalTokens: 91, contextLimit: 100 },
    calls: [responseCall("need", "context_need", '{"min_remaining_tokens":40}')],
  });
  await wait(() => rounds(turn).length === 2);
  live.model.reply({ text: "Done." });
  await wait(() => turn.reducerExited);
  doc.off("update", capture);
  expect({
    violations,
    captured: image != null,
    compacts: turn.children.filter((job) => job instanceof CompactJob).length,
  }).toEqual({ violations: [], captured: true, compacts: 1 });
  const recovered = await liveSession(image!, {}, live.project.path, true);
  recovered.model.reply({ text: "Recovered answer." });
  const restored = recovered.session.root.head as SessionTurn;
  await wait(() => restored.reducerExited);
  expect({
    compacts: restored.children
      .filter((job): job is CompactJob => job instanceof CompactJob)
      .map((job) => ({ id: job.uuid, cutoff: job.cutoff })),
    rounds: rounds(restored).length,
    source: rounds(restored)[0]?.expectation.outcome,
  }).toEqual({ compacts: [{ id: compactId, cutoff: true }], rounds: 2, source: "successful" });
});
