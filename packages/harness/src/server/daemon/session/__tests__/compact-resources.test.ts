import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { prompt } from "@inhuman.tools/harness-commons";
import {
  CompactJob,
  CompletionExpectation,
  CompletionJob,
  SessionPlexus,
  SessionSystemPrompt,
  SessionTurn,
} from "@inhuman.tools/harness-model";
import { expect, onTestFinished, test } from "vitest";
import * as Y from "yjs";

import { textOfCell, Transcript } from "@/context";
import { applyCompact, runCompactJob } from "@/session";

import { loadCompactProgram } from "../compact.js";

test("local strategy imports remain pinned and confined after preparation", async () => {
  const root = await mkdtemp(join(tmpdir(), "compact-resources-"));
  const outside = await mkdtemp(join(tmpdir(), "compact-outside-"));
  onTestFinished(async () => {
    await Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]);
  });
  await writeFile(
    join(root, "compact.scm"),
    '(define text (require "card.txt")) (define (compact p f) (list (message/user text)))',
  );
  await writeFile(join(root, "card.txt"), "pinned local card");
  await writeFile(join(outside, "private.txt"), "outside content");
  await symlink(join(outside, "private.txt"), join(root, "escape.txt"));
  const program = loadCompactProgram("./compact.scm", root);
  if (program.moduleLoader === undefined) throw new Error("local loader missing");
  const round = new CompletionExpectation({ connectionId: "model" });
  round.responseText = "evidence ".repeat(200);
  round.totalTokens = 10_000;
  round.contextLimit = 100_000;
  const transcript = Transcript.fromCells([round], 100_000);
  const first = await applyCompact(program.source, transcript, transcript, { moduleLoader: program.moduleLoader });
  await writeFile(join(root, "card.txt"), "newer local card");
  const repeated = await applyCompact(program.source, transcript, transcript, { moduleLoader: program.moduleLoader });
  let escape: string | null = null;
  try {
    const key = await program.moduleLoader.resolve("escape.txt", "");
    await program.moduleLoader.read(key);
  } catch (error) {
    escape = error instanceof Error ? error.message : String(error);
  }
  expect({
    first: first.ok ? first.checkIn.map(textOfCell) : first.reason,
    repeated: repeated.ok ? repeated.checkIn.map(textOfCell) : repeated.reason,
    escape,
  }).toEqual({
    first: ["pinned local card"],
    repeated: ["pinned local card"],
    escape: expect.stringContaining("require path escapes program source root"),
  });
});

test("local nested imports replay from the durable captured closure after the source directory disappears", async () => {
  const root = await mkdtemp(join(tmpdir(), "compact-replay-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "steps"));
  await writeFile(
    join(root, "compact.scm"),
    '(require "steps/card.scm") (define (compact p f) (list (message/user card)))',
  );
  await writeFile(join(root, "steps/card.scm"), '(define card (require "../card.txt"))');
  await writeFile(join(root, "card.txt"), "local captured card");
  const session = SessionPlexus.create("local-compact-replay", root);
  onTestFinished(() => session.destroy());
  const seen: CompletionExpectation[] = [];
  const tail = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user`prior`,
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
  let committed: Uint8Array | undefined;
  await runCompactJob(job, {
    turn,
    session: session.root,
    compactKeepTurns: 1,
    connectionId: "model",
    model: "summarizer",
    program: loadCompactProgram("./compact.scm", root),
    async checkpoint() {
      committed = Y.encodeStateAsUpdate(session.doc);
    },
  });
  expect(job.standIn).toBe("local captured card");
  expect(job.resourceSnapshotJson).toContain('"steps/card.scm":');
  expect(job.resourceSnapshotJson).toContain('"card.txt":');
  if (committed === undefined) throw new Error("missing resource checkpoint");
  await rm(root, { recursive: true, force: true });
  const doc = new Y.Doc({ guid: session.doc.guid });
  Y.applyUpdate(doc, committed);
  const restored = SessionPlexus.connect(doc);
  onTestFinished(() => restored.destroy());
  const restoredTurn = restored.root.head;
  if (!(restoredTurn instanceof SessionTurn)) throw new TypeError("missing restored turn");
  const restoredJob = restoredTurn.doneWork.find((node): node is CompactJob => node instanceof CompactJob);
  if (restoredJob === undefined) throw new Error("missing restored compact job");
  await runCompactJob(restoredJob, {
    turn: restoredTurn,
    session: restored.root,
    compactKeepTurns: 1,
    connectionId: "model",
    model: "summarizer",
    compactStrategy: "must-not-load",
    kernelFsRoot: root,
    loadProgram() {
      throw new Error("source directory is gone");
    },
    checkpoint: async () => {},
  });
  expect({ card: restoredJob.standIn, complete: restoredJob.completed, failed: restoredJob.failed }).toEqual({
    card: "local captured card",
    complete: true,
    failed: false,
  });
});
