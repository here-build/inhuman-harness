import { prompt } from "@inhuman.tools/harness-commons";
import {
  CompletionExpectation,
  CompletionJob,
  CompactJob,
  SessionPlexus,
  SessionSystemPrompt,
  SessionTurn,
} from "@inhuman.tools/harness-model";
import * as sessionModel from "@inhuman.tools/harness-model/session";
import { reaction } from "mobx";
import { expect, it, onTestFinished, vi } from "vitest";
import * as Y from "yjs";

import { Transcript, textOfCell } from "../../context/index.js";
import { runCompactJob } from "../../session/compact-actor.js";
import { applyCompact } from "../../session/compact-env.js";
import { bundledCompactProgram, createModuleBundle } from "../index.js";

function history(): Transcript {
  const round = new CompletionExpectation({ connectionId: "model", promptText: prompt.user`Keep this exact request` });
  round.responseText = "Evidence from the completed work. ".repeat(100);
  round.totalTokens = 10_000;
  round.contextLimit = 100_000;
  return Transcript.fromCells([round], 100_000);
}

it("runs the shipped strategy and captured prompt without a workspace directory", async () => {
  const session = SessionPlexus.create("bundled-compact", "");
  onTestFinished(() => session.destroy());
  const turn = new SessionTurn({ turnTail: new SessionSystemPrompt(), prompt: prompt.user`current`, queue: [] });
  session.root.head = turn;
  const requests: string[] = [];
  const stop = reaction(
    () => [...turn.children],
    (children) => {
      for (const child of children) {
        if (!(child instanceof CompletionJob) || child.expectation.isDone) continue;
        requests.push(child.expectation.userPrompt);
        child.expectation.succeed("settled", "", "null", {
          result: { text: "Goals & Requests: Keep this exact request" },
        });
      }
    },
  );
  onTestFinished(stop);
  const program = bundledCompactProgram();
  const transcript = history();
  const result = await applyCompact(program.source, transcript, transcript, {
    moduleLoader: program.moduleLoader,
    job: turn,
    connectionId: "model",
    completionModel: "summarizer",
    forced: true,
  });
  expect({
    compacted: result.ok,
    card: result.ok ? result.checkIn.map(textOfCell).join("\n") : result.reason,
    requests: requests.map((text) => ({
      carriesRequest: text.includes("Keep this exact request"),
      carriesEvidence: text.includes("Evidence from the completed work."),
    })),
    versioned: program.resource?.revision.startsWith("sha256:"),
    path: session.root.path,
  }).toEqual({
    compacted: true,
    card: expect.stringContaining("Goals & Requests: Keep this exact request"),
    requests: [{ carriesRequest: true, carriesEvidence: true }],
    versioned: true,
    path: "",
  });
});

it("pins nested module content and rejects imports outside its namespace", async () => {
  const modules = {
    "steps/card.scm": '(define card (require "../card.txt"))',
    "card.txt": "captured",
  };
  const bundle = createModuleBundle({ id: "tenant:one/strategy", revision: "v1", modules });
  modules["card.txt"] = "changed after preparation";
  const transcript = history();
  const result = await applyCompact(
    '(require "steps/card.scm") (define (compact prefix full) (list (message/user card)))',
    transcript,
    transcript,
    { moduleLoader: bundle.loader },
  );
  const denied: string[] = [];
  for (const path of ["../other/card.txt", "/other/card.txt", "other:strategy/card.txt", "missing.txt"]) {
    try {
      const key = await bundle.loader.resolve(path, "");
      await bundle.loader.read(key);
    } catch {
      denied.push(path);
    }
  }
  expect({ card: result.ok ? result.checkIn.map(textOfCell) : result.reason, denied }).toEqual({
    card: ["captured"],
    denied: ["../other/card.txt", "/other/card.txt", "other:strategy/card.txt", "missing.txt"],
  });
});

it("checkpoints source and imported content before use, then restores only the captured closure", async () => {
  const session = SessionPlexus.create("captured-compact", "");
  onTestFinished(() => session.destroy());
  const seen: CompletionExpectation[] = [];
  const tail = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user`earlier`,
    doneWork: [20, 40, 80].map((used) => {
      const round = new CompletionExpectation({ connectionId: "model", messages: [...seen] });
      seen.push(round);
      round.totalTokens = used;
      round.contextLimit = 100;
      round.responseText = "prior evidence ".repeat(100);
      return new CompletionJob({ expectation: round });
    }),
    queue: [],
    reducerExited: true,
  });
  const job = new CompactJob({ reason: "user" });
  const turn = new SessionTurn({ turnTail: tail, prompt: prompt.user`keep`, queue: [], doneWork: [job] });
  turn.pushChild(job);
  session.root.head = turn;
  const bundle = createModuleBundle({ id: "capture", revision: "v1", modules: { "card.txt": "original card" } });
  let committed: Uint8Array | undefined;
  const checkpoints: string[] = [];
  const failures: string[] = [];
  await runCompactJob(job, {
    turn,
    session: session.root,
    compactKeepTurns: 1,
    connectionId: "model",
    model: "summarizer",
    program: {
      source: '(define card (require "card.txt")) (define (compact prefix full) (list (message/user card)))',
      sourcePath: "capture:compact",
      resource: { id: bundle.id, revision: bundle.revision },
      moduleLoader: bundle.loader,
    },
    async checkpoint(node) {
      checkpoints.push(node.resourceSnapshotJson.includes("original card") ? "module" : "source");
      committed = Y.encodeStateAsUpdate(session.doc);
    },
    fail: (label, error) => failures.push(`${label}: ${String(error)}`),
  });
  expect({ checkpoints, card: job.standIn, complete: job.completed, failures }).toEqual({
    checkpoints: ["source", "module"],
    card: "original card",
    complete: true,
    failures: [],
  });
  if (committed === undefined) throw new Error("missing committed source checkpoint");
  const document = new Y.Doc({ guid: session.doc.guid });
  Y.applyUpdate(document, committed);
  const restored = SessionPlexus.connect(document);
  onTestFinished(() => restored.destroy());
  const restoredTurn = restored.root.head;
  if (!(restoredTurn instanceof SessionTurn)) throw new TypeError("missing restored turn");
  const restoredJob = restoredTurn.doneWork.find((node): node is CompactJob => node instanceof CompactJob);
  if (restoredJob === undefined) throw new Error("missing restored compact job");
  let newerSourceLoads = 0;
  await runCompactJob(restoredJob, {
    turn: restoredTurn,
    session: restored.root,
    compactKeepTurns: 1,
    connectionId: "model",
    model: "summarizer",
    compactStrategy: "newer-strategy",
    kernelFsRoot: "",
    loadProgram() {
      newerSourceLoads += 1;
      throw new Error("newer resources must not be consulted");
    },
    checkpoint: async () => {},
  });
  expect({ card: restoredJob.standIn, complete: restoredJob.completed, newerSourceLoads }).toEqual({
    card: "original card",
    complete: true,
    newerSourceLoads: 0,
  });
});

it("leaves a replacement owner's compact outcome intact when the old background check resolves", async () => {
  const session = SessionPlexus.create("compact-owner-race", "");
  onTestFinished(() => session.destroy());
  const seen: CompletionExpectation[] = [];
  const tail = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user`earlier`,
    queue: [],
    reducerExited: true,
    doneWork: [20, 40, 80].map((used) => {
      const round = new CompletionExpectation({ connectionId: "model", messages: [...seen] });
      seen.push(round);
      round.totalTokens = used;
      round.contextLimit = 100;
      round.responseText = "prior evidence ".repeat(100);
      return new CompletionJob({ expectation: round });
    }),
  });
  const job = new CompactJob({ reason: "user" });
  const turn = new SessionTurn({ turnTail: tail, prompt: prompt.user`keep`, queue: [], doneWork: [job] });
  turn.pushChild(job);
  session.root.head = turn;
  const entered = Promise.withResolvers<void>();
  const pending = Promise.withResolvers<sessionModel.LiveBackgroundJob[]>();
  const spy = vi.spyOn(sessionModel, "liveBackgroundJobs").mockImplementationOnce(() => {
    entered.resolve();
    return pending.promise;
  });
  onTestFinished(() => spy.mockRestore());
  const host = {
    turn,
    session: session.root,
    compactKeepTurns: 1,
    connectionId: "model",
    model: "summarizer",
    program: { source: '(define (compact p f) (list (message/user "owner card")))', sourcePath: null },
    checkpoint: async () => {},
  };
  const old = new AbortController();
  const running = runCompactJob(job, host, old.signal);
  await entered.promise;
  old.abort("replaced");
  await runCompactJob(job, host, new AbortController().signal);
  const replacement = { card: job.standIn, complete: job.completed, failed: job.failed, notice: job.notice };
  pending.resolve([{ jobId: "stale-job", kind: "command", object: "old background work" }]);
  await running;
  expect({ card: job.standIn, complete: job.completed, failed: job.failed, notice: job.notice }).toEqual(replacement);
  expect(replacement).toEqual({ card: "owner card", complete: true, failed: false, notice: "" });
});
