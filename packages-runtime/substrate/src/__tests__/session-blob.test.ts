// The session-blob round-trip (`DoorsRunner.exportSession` / `restoreSession`) had ZERO
// callers and ZERO tests before this file — an audit marked the pair `public-keep`, so it ships
// regardless of call sites. These tests are the contract that a rewrite of
// `parseSessionBlob` (runner.ts) must not break:
//
//   1. ROUND TRIP — teaching state really survives export → restore → re-run.
//      Observable via the door-session dedup: a lesson renders VERBOSE on its first
//      occurrence and TERSE on every later one, and the terse-ness is what crosses the
//      blob. A restored runner that re-runs the SAME program must render terse; a fresh
//      runner must render verbose. (This is the only externally visible behavior the
//      blob carries — the trackers themselves are not on any public read path.)
//   2. REJECTION — a malformed blob is refused, and refused BEFORE any tracker is
//      mutated (a failed restore leaves the runner's state untouched).
//   3. TOLERANCE — the blob is a versioned, forward-compatible format: unknown keys are
//      stripped (the removed `competence` key), a missing additive key degrades to the
//      documented empty default, and a DoorCode renamed between releases is kept
//      verbatim rather than rejecting the blob.

import { LexicalScope, RunContext, disposeRunContext, execState } from "@here.build/arrival";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AttachmentSink } from "../attachment-sink.js";
import type { BoundTool } from "../bound-tool.js";
import { createDoorsRunner } from "../runner.js";
import { KWARGS_STRATEGIES } from "../strategies.js";

const noopSink: AttachmentSink = {
  beginCall(): void {},
  drainBlocks: () => [],
  drainNote: () => undefined,
};

function makeRunner(): ReturnType<typeof createDoorsRunner> {
  return createDoorsRunner({
    toolNaming: { toolName: "eval", argName: "expr" },
    strategies: KWARGS_STRATEGIES,
    attachmentSink: noopSink,
  });
}

const capabilities: readonly [] = [];
const config: Record<string, unknown> = {};
let runCtx: RunContext;
beforeAll(async () => {
  const state = await execState("(begin)", {
    capabilities,
    config,
    scope: LexicalScope.fresh("session-blob-test-mint"),
  });
  runCtx = state.runCtx;
});
afterAll(async () => {
  await disposeRunContext(runCtx);
});

function freshScope(name: string): LexicalScope {
  return LexicalScope.fresh(name);
}

const noTools = new Map<string, BoundTool>();

/** The program that arms the import-form door (an unbound `(scheme base)` head). Its
 *  first occurrence renders the VERBOSE lesson; the door session's `seen` set is what
 *  makes later occurrences terse. */
const DOOR_PROGRAM = "(scheme base) (+ 1 2)";
const VERBOSE_LESSON = "standard library is already fully bound";

async function runProgram(runner: ReturnType<typeof createDoorsRunner>, scopeName: string): Promise<string> {
  const result = await runner.run({
    expr: DOOR_PROGRAM,
    capabilities,
    config,
    runCtx,
    scope: freshScope(scopeName),
    tools: noTools,
  });
  return result.content.map((b) => (b.type === "text" ? b.text : "")).join("\n");
}

describe("session blob — round trip", () => {
  it("teaching state survives export → restore (a restored runner renders the door lesson TERSE, a fresh one VERBOSE)", async () => {
    const first = makeRunner();
    const firstRun = await runProgram(first, "blob-roundtrip-first");
    expect(firstRun).toContain(VERBOSE_LESSON); // verbose: the lesson's first occurrence

    const blob = first.exportSession();
    expect(() => JSON.parse(blob)).not.toThrow(); // the blob is real JSON

    const restored = makeRunner();
    restored.restoreSession(blob);
    const restoredRun = await runProgram(restored, "blob-roundtrip-restored");
    expect(restoredRun).not.toContain(VERBOSE_LESSON); // terse: `seen` crossed the blob

    // Control: a runner that never restored still teaches verbosely.
    const control = makeRunner();
    const controlRun = await runProgram(control, "blob-roundtrip-control");
    expect(controlRun).toContain(VERBOSE_LESSON);
  });

  it("restoring twice from the same blob is idempotent (full rehydration, never a merge)", async () => {
    const source = makeRunner();
    await runProgram(source, "blob-idempotent-source");
    const blob = source.exportSession();

    const target = makeRunner();
    target.restoreSession(blob);
    target.restoreSession(blob);
    const rendered = await runProgram(target, "blob-idempotent-target");
    expect(rendered).not.toContain(VERBOSE_LESSON);
  });
});

describe("session blob — rejection (malformed input is refused, state untouched)", () => {
  it.each([
    ["not JSON at all", "({not json"],
    ["JSON null", "null"],
    ["JSON array", "[]"],
    ["JSON number", "42"],
    ["JSON string", '"a string"'],
    [
      "wrong version",
      JSON.stringify({
        v: 2,
        history: [],
        cache: {},
        futility: [],
        localBindings: [],
        doorSession: { seen: [], pendingFollow: [], seq: 0 },
        contextRing: [],
      }),
    ],
    ["missing every field", "{}"],
    [
      "history not an array",
      JSON.stringify({
        v: 1,
        history: "nope",
        cache: {},
        futility: [],
        localBindings: [],
        doorSession: { seen: [], pendingFollow: [], seq: 0 },
        contextRing: [],
      }),
    ],
    [
      "history element missing `source`",
      JSON.stringify({
        v: 1,
        history: [{ name: "x" }],
        cache: {},
        futility: [],
        localBindings: [],
        doorSession: { seen: [], pendingFollow: [], seq: 0 },
        contextRing: [],
      }),
    ],
    [
      "doorSession not an object",
      JSON.stringify({
        v: 1,
        history: [],
        cache: {},
        futility: [],
        localBindings: [],
        doorSession: "nope",
        contextRing: [],
      }),
    ],
    [
      "futility element not a [string, state] pair",
      JSON.stringify({
        v: 1,
        history: [],
        cache: {},
        futility: ["solo"],
        localBindings: [],
        doorSession: { seen: [], pendingFollow: [], seq: 0 },
        contextRing: [],
      }),
    ],
    [
      "futility tool state missing `ring`",
      JSON.stringify({
        v: 1,
        history: [],
        cache: {},
        futility: [["tool", {}]],
        localBindings: [],
        doorSession: { seen: [], pendingFollow: [], seq: 0 },
        contextRing: [],
      }),
    ],
  ])("rejects %s", (_label, blob) => {
    const runner = makeRunner();
    expect(() => runner.restoreSession(blob as string)).toThrow();
  });

  it("a failed restore mutates nothing (a later valid restore still works)", async () => {
    const source = makeRunner();
    await runProgram(source, "blob-reject-source");
    const good = source.exportSession();

    const target = makeRunner();
    expect(() => target.restoreSession("{not json")).toThrow();
    // The runner is still usable and still teaches verbosely — the reject left it pristine.
    expect(await runProgram(target, "blob-reject-after-failure")).toContain(VERBOSE_LESSON);

    target.restoreSession(good);
    expect(await runProgram(target, "blob-reject-after-good")).not.toContain(VERBOSE_LESSON);
  });
});

describe("session blob — tolerance (forward-compatible format)", () => {
  it("strips unknown keys (the removed `competence` key is ignored, not fatal)", async () => {
    const source = makeRunner();
    await runProgram(source, "blob-strip-source");
    const blob = JSON.parse(source.exportSession()) as Record<string, unknown>;
    blob.competence = { ignored: true }; // a key this version no longer knows
    const json = JSON.stringify(blob);

    const restored = makeRunner();
    expect(() => restored.restoreSession(json)).not.toThrow();
    expect(await runProgram(restored, "blob-strip-target")).not.toContain(VERBOSE_LESSON);
  });

  it("a missing additive `argsFailures` key restores an empty tracker, never an error", async () => {
    const source = makeRunner();
    await runProgram(source, "blob-argsfailures-source");
    const blob = JSON.parse(source.exportSession()) as Record<string, unknown>;
    delete blob.argsFailures; // a blob predating the args-misuse escalation counters
    const json = JSON.stringify(blob);

    const restored = makeRunner();
    expect(() => restored.restoreSession(json)).not.toThrow();
    expect(await runProgram(restored, "blob-argsfailures-target")).not.toContain(VERBOSE_LESSON);
  });

  it("a DoorCode renamed since the blob was written is kept verbatim, not fatal", async () => {
    const source = makeRunner();
    await runProgram(source, "blob-doorcode-source");
    const blob = JSON.parse(source.exportSession()) as Record<string, unknown>;
    const doorSession = blob.doorSession as { pendingFollow: [string, string][] };
    // A code this release never emitted. pendingFollow values are only ever logged
    // verbatim (doors.ts observeSuccess), never matched against the current door set —
    // so an unknown code is harmless, and rejecting it would break every old blob on
    // the next door rename.
    doorSession.pendingFollow = [["some-tool", "envelope/renamed-in-a-later-release"]];
    const json = JSON.stringify(blob);

    const restored = makeRunner();
    expect(() => restored.restoreSession(json)).not.toThrow();
  });
});
