// A RUNAWAY LOOP ENDS A PROGRAM. IT MUST NEVER END A SESSION.
//
// A real trajectory hit this: a char-walking `let loop` runaway legitimately tripped the trace
// cap, but every eval after it — arithmetic, `define`, string builtins, every MCP tool — kept
// failing for the rest of the session, with no recovery door back in.
//
// ─── THE CHAIN ──────────────────────────────────────────────────────────────────────────────────
//
// The tap is per-SESSION by design (one EvalTrace per world build — provenance must resolve across
// calls: a value minted in call 1, read back in call 3). But the cap was enforced against a counter
// that only reset in `clear()`. So:
//
//   1. A program legitimately exceeds the cap — `enter` THROWS mid-eval.
//   2. The eval unwinds, so entered invocations never `exit` — `#openCount` stays > 0.
//   3. The per-call GC calls `clear()`, which asserts `#openCount === 0` — it throws, and the throw
//      is SWALLOWED (that catch was written for abandoned timeout evals, which do eventually exit;
//      an unwound eval never will).
//   4. The counter is pinned at the ceiling forever. Every later `enter` throws on sight.
//
// A guard against a runaway loop must not be able to outlive the loop. `EvalTrace.beginRun()` re-arms
// the cap at the top of every run, which makes step 4 unreachable.
//
// These tests are the gate on that. The positive side proves the guard still guards; the negative
// side — the one that matters — proves it cannot take the session with it.

import { EvalTrace } from "@here.build/arrival/provenance";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildManifoldEnv } from "../bind.js";
import { createManifoldTool } from "../manifold-tool.js";

// A single 500k-step burn costs roughly 35s of real interpreter time, and every NEGATIVE case
// arms one in beforeEach. The law needs the production cap — a small cap would pass without
// exercising the real burn — so the price is the timeout, not the size.
vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

/** A tool wired exactly as `server.ts` wires it: ONE tap, shared across every call of the session.
 *  The small cap keeps the arithmetic legible — the law is about the cap's LIFETIME, not its size. */
const session = async (cap: number) => {
  const env = await buildManifoldEnv([]);
  const trace = new EvalTrace(cap);
  const tool = createManifoldTool(env as never, "", { trace }) as {
    call(args: { expr: string }): Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
  };
  return async (expr: string): Promise<string> => (await tool.call({ expr })).content.map((b) => b.text).join(" ");
};

/** THE SHAPE THAT MATTERS: a char-walking `let loop`, not a `(map (lambda …) (iota N))` runaway.
 *
 *  A `map`/`iota` runaway unwinds CLEANLY when the cap fires, so the per-call `clear()` still
 *  succeeds and the session survives even if the counter-pinning bug above is present — that
 *  shape cannot exercise or gate the fix.
 *
 *  A char-walking `let loop` does NOT unwind cleanly — the throw leaves entered frames open, so
 *  `#openCount` stays > 0, `clear()`'s invariant throws, the runner swallows it, and the counter is
 *  pinned at the ceiling for the rest of the session. Reproduce the bug with the shape that causes
 *  it, not with a shape that merely resembles it. */
const PAGE =
  '(define full-page (string-join (map (lambda (i) "https://www.rottentomatoes.com/m/x abcdefghijklmnopqrst") (iota 600)) " "))';
const RUNAWAY = String.raw`(define (find-all-rt-urls s)
  (let loop ((start 0) (acc '()))
    (let ((idx (string-contains s "https://www.rottentomatoes.com/m/" start)))
      (if idx
          (let* ((end (or (string-index s #\space idx) (string-length s))))
            (loop end (cons (substring s idx end) acc)))
          (reverse acc)))))
(length (find-all-rt-urls full-page))`;

describe("POSITIVE — the guard still guards", () => {
  it("a genuine runaway loop IS stopped", async () => {
    const run = await session(500_000);
    await run(PAGE);
    expect(await run(RUNAWAY)).toContain("was stopped");
  });

  it("the door teaches an action the model can actually take", async () => {
    const run = await session(500_000);
    await run(PAGE);
    const err = await run(RUNAWAY);
    // It must NOT name ARRIVAL_TRACE_MAX: that is a host env var, unreachable from an MCP tool call.
    // A remedy the reader cannot perform is not a remedy — it reads as "the sandbox is broken".
    expect(err).not.toContain("ARRIVAL_TRACE_MAX");
    // It must offer something doable in the next program.
    expect(err.toLowerCase()).toMatch(/bound the loop|slice|take/);
    // And it must say the session survived — the model that hit this believed its world was dead.
    expect(err).toContain("INTACT");
  });
});

// ─── THE LAW ────────────────────────────────────────────────────────────────────────────────────
describe("NEGATIVE — the guard cannot outlive the program it stopped", () => {
  let run: (expr: string) => Promise<string>;

  beforeEach(async () => {
    run = await session(500_000);
    await run(PAGE);
    expect(await run(RUNAWAY)).toContain("was stopped"); // arm the failure, exactly as the model did
  });

  it("arithmetic still works after a runaway loop was stopped", async () => {
    expect(await run("(+ 1 2)")).toContain("3");
  });

  it("`define` still works — the session is not read-only either", async () => {
    await run("(define x 41)");
    expect(await run("(+ x 1)")).toContain("42");
  });

  it("a string builtin still works", async () => {
    expect(await run('(string-length "hello")')).toContain("5");
  });

  it("bindings made BEFORE the runaway survive it", async () => {
    const fresh = await session(500_000);
    await fresh(PAGE);
    await fresh('(define kept "the-data-i-fetched")');
    expect(await fresh(RUNAWAY)).toContain("was stopped");
    // The whole point of the door's promise: "Your earlier definitions are INTACT."
    expect(await fresh("(string-length kept)")).toContain("18");
  });

  it("TWO runaways in a row still leave a working session (the guard re-arms, it does not latch)", async () => {
    expect(await run(RUNAWAY)).toContain("was stopped");
    expect(await run(RUNAWAY)).toContain("was stopped");
    expect(await run("(+ 1 2)")).toContain("3");
  });

  it("a program under the cap NEVER trips it, no matter how many ran before", async () => {
    // The session-lifetime bug in one assertion: each of these is individually tiny, and under the
    // old accounting their SUM would eventually cross the cap and kill everything after it.
    for (let i = 0; i < 12; i++) {
      const out = await run("(length (map (lambda (i) (+ i 1)) (iota 300)))");
      expect(out, `call ${i} must not inherit an earlier program's step count`).toContain("300");
    }
  });
});
