import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetLocalIDs } from "@here.build/plexus";
import { prompt } from "@inhuman.tools/harness-commons";
import {
  CompactJob,
  CompletionExpectation,
  CompletionJob,
  HARNESS_CONSTITUTION,
  SessionSystemPrompt,
  SessionTurn,
} from "@inhuman.tools/harness-model";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Transcript } from "../../context/index.js";
import { applyCompact, loadCompactProgram, runCompactJob } from "../index.js";
import { sessionOf } from "./fixtures.js";

const KEEP_FIRST = `
(define (compact compact-transcript full-transcript)
  (let ((xs (transcript/cells compact-transcript)))
    (if (null? xs) xs (list (car xs)))))
`;

beforeEach(() => resetLocalIDs());

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
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

describe("compaction actor", () => {
  it("applyCompact refuses empty, missing define, and non-shrinking cards", async () => {
    const prefix = spine([20, 40], 100);
    const full = spine([20, 40, 50], 100);
    expect(await settleError(applyCompact("", prefix, full))).toEqual({
      ok: false,
      message: "Invariant failed: compact strategy program is empty",
    });
    expect(await settleError(applyCompact("(define answer 42)", prefix, full))).toEqual({
      ok: false,
      message: expect.stringMatching(/does not define compact/),
    });
    expect(await applyCompact(`(define (compact compact-transcript full-transcript) '())`, prefix, full)).toEqual({
      ok: false,
      reason: "empty-check-in",
    });
    expect(await applyCompact(KEEP_FIRST, Transcript.empty(100), full)).toEqual({
      ok: false,
      reason: "empty-check-in",
    });
    expect(
      await applyCompact(
        `(define (compact compact-transcript full-transcript)
           (list (message/user "${"x".repeat(200)}")))`,
        prefix,
        full,
      ),
    ).toEqual({ ok: false, reason: "did-not-shrink" });
    const kept = await applyCompact(KEEP_FIRST, prefix, full);
    expect(kept.ok).toBe(true);
  });

  it("loadCompactProgram falls back inline and reads a resolve host path", async () => {
    expect(loadCompactProgram().source).toContain("(define (compact");
    const dir = mkdtempSync(join(tmpdir(), "session-compact-"));
    writeFileSync(join(dir, "mine.scm"), "(define (compact compact-transcript full-transcript) '(custom-card))\n");
    const loaded = loadCompactProgram("./mine.scm", dir, {
      resolvePath: (spec, root) => join(root, spec.replace(/^\.\//, "")),
      defaultSource: () => "",
      packageStrategyPath: () => null,
      readFile: (path) => readFileSync(path, "utf8"),
    });
    expect(loaded.source).toContain("custom-card");
  });

  it("keep-first is only a failsafe: flagged when no real program loads, absent otherwise", () => {
    const real = '(define (compact t f) (list (message/user "real")))';
    const resolveOf = (over: Partial<Parameters<typeof loadCompactProgram>[2] & object>) => ({
      resolvePath: (spec: string, root: string) => join(root, spec),
      defaultSource: () => real,
      packageStrategyPath: () => "/pkg/compact.scm",
      readFile: () => real,
      ...over,
    });
    // The shipped default loads: no failsafe.
    expect(loadCompactProgram(undefined, undefined, resolveOf({}))).toEqual({
      source: real,
      sourcePath: "/pkg/compact.scm",
    });
    // The configured file is lost: the shipped default stands in, still no failsafe.
    const lost = loadCompactProgram(
      "./gone.scm",
      "/k",
      resolveOf({
        readFile: () => {
          throw new Error("ENOENT");
        },
      }),
    );
    expect(lost.failsafe).toBeUndefined();
    expect(lost.source).toBe(real);
    // Both the configured file and the shipped default are lost: keep-first, and it says why.
    const broken = loadCompactProgram(
      "./gone.scm",
      "/k",
      resolveOf({
        readFile: () => {
          throw new Error("ENOENT");
        },
        defaultSource: () => {
          throw new Error("shipped compaction prompt is missing");
        },
      }),
    );
    expect(broken.source).toContain("(car xs)");
    expect(broken.sourcePath).toBeNull();
    expect(broken.failsafe).toMatch(/gone\.scm.*ENOENT.*shipped default program could not be read.*prompt is missing/);
    // No resolver at all is also a failsafe.
    expect(loadCompactProgram().failsafe).toBe("no strategy resolver");
    // An empty shipped default is a failsafe too.
    expect(
      loadCompactProgram(undefined, undefined, resolveOf({ defaultSource: () => ";; just a comment\n" })).failsafe,
    ).toMatch(/shipped default program is empty/);
  });

  it("runCompactJob logs a diagnostic when it runs on the failsafe", async () => {
    const plexus = sessionOf("failsafe");
    const seen: CompletionExpectation[] = [];
    const priors = [20, 40, 80].map((used, i) => {
      const pew = new CompletionExpectation({ connectionId: "c1", messages: [...seen] });
      seen.push(pew);
      pew.totalTokens = used;
      pew.contextLimit = 100;
      pew.responseText = `hello ${i}`;
      return new CompletionJob({ expectation: pew });
    });
    const job = new CompactJob({ reason: "user" });
    const turn = new SessionTurn({
      turnTail: new SessionTurn({
        turnTail: new SessionSystemPrompt({ constitution: HARNESS_CONSTITUTION }),
        prompt: prompt.user`hi`,
        doneWork: priors,
        queue: [],
        reducerExited: true,
      }),
      prompt: prompt.user`keep`,
      queue: [],
      doneWork: [job],
    });
    turn.pushChild(job);
    plexus.root.head = turn;
    const failures: Array<[string, unknown]> = [];
    await runCompactJob(job, {
      turn,
      session: plexus.root,
      compactKeepTurns: 1,
      compactStrategy: "",
      kernelFsRoot: "",
      connectionId: "",
      model: "",
      loadProgram: () => loadCompactProgram(),
      fail: (label, error) => failures.push([label, error]),
    });
    expect(failures).toEqual([["compact failsafe", expect.stringContaining("using keep-first")]]);
    // The failsafe still produces a card; it is the diagnostic that marks it as one.
    expect({ completed: job.completed, failed: job.failed, stamped: job.keepTurns }).toEqual({
      completed: true,
      failed: false,
      stamped: 1,
    });
  });

  it("runCompactJob writes a keep-first card onto the CompactJob", async () => {
    const plexus = sessionOf("prefix");
    const priors = [20, 40, 80].map((used, i) => {
      const pew = new CompletionExpectation({ connectionId: "c1" });
      pew.totalTokens = used;
      pew.contextLimit = 100;
      pew.responseText = `hello ${i}`;
      return new CompletionJob({ expectation: pew });
    });
    const tail = new SessionTurn({
      turnTail: new SessionSystemPrompt({ constitution: HARNESS_CONSTITUTION }),
      prompt: prompt.user`hi`,
      doneWork: priors,
      queue: [],
      reducerExited: true,
    });
    const job = new CompactJob({ reason: "user" });
    const turn = new SessionTurn({
      turnTail: tail,
      prompt: prompt.user`keep`,
      queue: [],
      doneWork: [job],
    });
    turn.pushChild(job);
    plexus.root.head = turn;
    await runCompactJob(job, {
      turn,
      session: plexus.root,
      compactKeepTurns: 1,
      compactStrategy: "",
      kernelFsRoot: "",
      connectionId: "",
      model: "",
      loadProgram: () => ({ source: KEEP_FIRST, sourcePath: null }),
    });
    expect({ completed: job.completed, failed: job.failed }).toEqual({
      completed: true,
      failed: false,
    });
  });

  it("runCompactJob returns on abort without waiting for the summarizer, which joins the abort", async () => {
    const plexus = sessionOf("abort");
    const dir = mkdtempSync(join(tmpdir(), "session-compact-abort-"));
    writeFileSync(join(dir, "hang.prompt"), '{{role "user"}}\nsummarize\n');
    const source = `(define summarize (require "hang.prompt"))
(define (compact compact-transcript full-transcript) (list (message/user (summarize))))`;
    const seen: CompletionExpectation[] = [];
    const rounds = [20, 40, 80].map((used) => {
      const pew = new CompletionExpectation({ connectionId: "c1", messages: [...seen] });
      seen.push(pew);
      pew.totalTokens = used;
      pew.contextLimit = 100;
      pew.responseText = `reply ${used}`;
      return new CompletionJob({ expectation: pew });
    });
    const job = new CompactJob({ reason: "overflow" });
    const turn = new SessionTurn({
      turnTail: new SessionSystemPrompt({ constitution: HARNESS_CONSTITUTION }),
      prompt: prompt.user`task`,
      queue: [],
      doneWork: [...rounds, job],
    });
    turn.pushChild(job);
    plexus.root.head = turn;
    const abort = new AbortController();
    const joined: AbortSignal[] = [];
    const running = runCompactJob(
      job,
      {
        turn,
        session: plexus.root,
        compactKeepTurns: 1,
        compactStrategy: "",
        kernelFsRoot: "",
        connectionId: "c1",
        model: "m",
        loadProgram: () => ({ source, sourcePath: join(dir, "compact.scm") }),
        complete: async (req) => {
          if (req.signal != null) joined.push(req.signal);
          return await new Promise<never>(() => {});
        },
      },
      abort.signal,
    );
    await vi.waitFor(() => expect(turn.children.some((child) => child instanceof CompletionJob)).toBe(true));
    abort.abort("cancel");
    await running;
    expect({
      completed: job.completed,
      joined: joined.map((signal) => signal.aborted),
    }).toEqual({ completed: false, joined: [true] });
  });

  it("runCompactJob completes a rejected empty eat without running a strategy", async () => {
    const plexus = sessionOf("empty-prefix");
    const job = new CompactJob({ reason: "user" });
    const turn = new SessionTurn({
      turnTail: new SessionSystemPrompt({ constitution: HARNESS_CONSTITUTION }),
      prompt: prompt.user``,
      queue: [job],
    });
    turn.pushChild(job);
    plexus.root.head = turn;
    let loaded = 0;
    await runCompactJob(job, {
      turn,
      session: plexus.root,
      compactKeepTurns: 1,
      compactStrategy: "",
      kernelFsRoot: "",
      connectionId: "",
      model: "",
      loadProgram: () => {
        loaded += 1;
        return { source: KEEP_FIRST, sourcePath: null };
      },
    });
    expect({ completed: job.completed, failed: job.failed, loaded }).toEqual({
      completed: true,
      failed: false,
      loaded: 0,
    });
  });
});
