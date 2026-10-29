// provenance-gc-release-child — the actual work `provenance-gc-release.test.ts` measures,
// run in a CHILD process (`--expose-gc`, via `npx tsx`) for the SAME reason
// `heap-canary-child.ts` is: the default vitest worker never gets `--expose-gc`, and an
// UNFORCED gc makes `process.memoryUsage().heapUsed` (and a `WeakRef` deref) noise, not
// signal — a coincidental collection could as easily hide a real leak as an absent one
// could fabricate one.
//
// Two phases, printed as ONE JSON object:
//
//   `direct`   — proves `EvalTrace.clear()` is the ACTUAL releaser of a provenance point's
//                retained value, via WeakRef exactness. Mints a point through the
//                manifold's REAL rosetta binding (`buildManifoldEnv` + a fake tool
//                returning an 8MB FLAT string), driving `execState({ ambient, scope, tap })`
//                directly — bypassing `manifold-tool.ts`'s `call()`, whose `finally` now
//                auto-clears the trace after every call (see that file's header), which
//                would make `clear()` untestable as a distinct, causal step. Then: drop
//                every OTHER reference (the session scope's `define` binding, the ambient,
//                our own locals) and prove the value SURVIVES on the trace alone (causality
//                leg #1 — the trace, not the scope, is what's retaining it), then `clear()`
//                and prove it's gone (causality leg #2).
//
//   `manifold` — the auto-clear invariant AT MAGNITUDE, exercised through the full
//                `createManifoldTool` + `tool.call()` path (where the auto-clear IS the
//                releasing act). A `WeakRef` taken DURING a call is impossible to reach
//                from outside `call()`'s own closure, so the externally-observable
//                equivalent is used instead: `trace.stats().entries === 0` after every one
//                of ten sequential 8MB-payload calls against ONE long-lived tool, plus a
//                flat heap slope across those calls — without the finally-clear this would
//                grow ~8MB/call (`FIXTURE_BYTES`), so a generously-below-that bound is a
//                real, non-coincidental gate.
//
// THE ROPE GOTCHA (cost a prior agent a false-negative harness): `"x".repeat(n)` builds a
// lazy V8 ConsString rope over the short source substring — it costs ~0 real heap no matter
// how large `n` claims to be, silently defanging a heap-retention probe. Fixtures here are
// built FLAT with the SAME technique `heap-canary-child.ts` already established:
// `Array.from({length}, () => row).join("")` forces one real, materialized allocation.

import { execState } from "@here.build/arrival";
import type { EvalTrace } from "@here.build/arrival/provenance";

import { buildManifoldEnv, type BoundServer, type ManifoldEnv, type RemoteTool } from "../bind.js";
import { createManifoldTool } from "../manifold-tool.js";

/** 8MB — big enough that a leaked/retained copy is unmistakable against GC noise (for
 *  scale: `heap-canary.test.ts`'s own regression bound is 10MB total), small enough that
 *  building it eleven times total (once for `direct`, ten times for `manifold`) stays a
 *  fast, deterministic test. */
const FIXTURE_BYTES = 8 * 1024 * 1024;

/** Same materialization technique as `heap-canary-child.ts`'s `tinyBlob` — see the ROPE
 *  GOTCHA note above for why `.repeat()` alone would silently defang this probe. Each call
 *  builds a genuinely FRESH string (never a shared/cached reference), which is what makes
 *  the `manifold` phase's per-call heap delta meaningful — a reused reference would cost
 *  nothing on repeat calls regardless of whether `clear()` ever ran. */
function flatBlob(bytes: number): string {
  const row = "id,name,value,note,extra-column-for-row-width\n"; // ~48 bytes/row
  const rows = Math.max(1, Math.ceil(bytes / row.length));
  return Array.from({ length: rows }, () => row).join("");
}

/** Real heap cost of a flat string like {@link flatBlob}'s output — ONE byte per code
 *  unit, not two: {@link flatBlob}'s row is pure ASCII, so V8 stores the joined result as
 *  a `SeqOneByteString` (Latin1 backing store), not the two-bytes/unit `SeqTwoByteString`
 *  a non-Latin1 string would need. `.length * 2` would systematically OVERCLAIM the true
 *  byte cost here and turn a correctly-working release into a false test failure — this is
 *  the ASCII-fixture analogue of the ROPE GOTCHA (a plausible-looking size formula that
 *  silently doesn't match what V8 actually allocates). Flat-string header/alignment
 *  overhead on top of this is deliberately NOT modeled — the parent test's slack factor
 *  absorbs it. */
function byteLength(s: string): number {
  return s.length;
}

function fakeServer(invoke: () => Promise<string>): BoundServer {
  const tool: RemoteTool = {
    name: "fake",
    inputSchema: { type: "object", properties: {}, required: [] },
    invoke,
  };
  return { slug: "t", tools: [tool] };
}

/** Two forced collections with a macrotask yield between them — the same
 *  FinalizationRegistry-grade hygiene `heap-canary-child.ts` uses, extended here to also
 *  give WeakRef derefs (not just `heapUsed`) a chance to settle before being read. */
async function forceGc(): Promise<void> {
  const gc = global.gc;
  if (!gc) throw new Error("provenance-gc-release-child: must run with --expose-gc");
  gc();
  await new Promise((resolve) => setTimeout(resolve, 0));
  gc();
}

interface DirectPhaseResult {
  heapBefore: number;
  heapAfter: number;
  aliveBeforeClear: boolean;
  aliveAfterClear: boolean;
  fixtureBytes: number;
}

/** Direct `EvalTrace` arming — see the file header's `direct` description. */
async function directPhase(): Promise<DirectPhaseResult> {
  // Measured off a THROWAWAY string, never bound to a variable that survives this
  // statement — the actual fixture returned to the tool call below is built FRESH inside
  // the closure (same shape as `manifoldPhase`'s tool), specifically so no outer `const`
  // binding in THIS function's scope keeps the real 8MB payload alive after the closure
  // itself is dropped. An async function's declared locals can outlive their last textual
  // use across `await` suspension points (V8 retains the whole surrounding context when it
  // can't prove otherwise) — an earlier version of this file bound `const fixture = ...`
  // here, and it single-handedly defeated the entire release measurement below (heapAfter
  // barely moved even though the WeakRef on the AString wrapper correctly went dead: the
  // wrapper was collected, but the raw string data survived via this stray reference).
  const fixtureBytes = byteLength(flatBlob(FIXTURE_BYTES));

  let manifoldEnv: ManifoldEnv | undefined = await buildManifoldEnv([fakeServer(async () => flatBlob(FIXTURE_BYTES))]);
  const trace: EvalTrace = manifoldEnv.trace;

  await execState("(define r (t/fake))", {
    capabilities: manifoldEnv.capabilities,
    config: manifoldEnv.config,
    runCtx: manifoldEnv.runCtx,
    scope: manifoldEnv.scope,
    tap: trace,
  });

  await forceGc();

  // Reach the EXACT object the trace retains — `invocation.value`, the post-jsToScheme
  // boxed value (an `AString` instance: a real object, WeakRef-able) — before dropping
  // anything else.
  let points: Array<{ invocation: { value?: unknown } }> | undefined = [...trace.points()];
  if (points.length !== 1 || points[0]!.invocation.value === undefined) {
    throw new Error(
      "provenance-gc-release-child: expected exactly one provenance point with a retained " +
        `value, got ${points.length}`,
    );
  }
  let retainedValue: object | undefined = points[0]!.invocation.value as object;
  const weakRef = new WeakRef(retainedValue);
  // Drop OUR OWN strong refs to the retained value immediately — `points`/`retainedValue`
  // would otherwise be a THIRD retainer alongside the trace and the session scope,
  // defeating the causality proof below (both legs would trivially read "alive").
  points = undefined;
  retainedValue = undefined;

  const heapBefore = process.memoryUsage().heapUsed;

  // CONTROL: drop every OTHER reference — the session scope's `(define r ...)` binding
  // and the ambient (both reachable only through `manifoldEnv`). `trace` is kept — it's
  // the thing under test, and `.clear()` below needs it.
  manifoldEnv = undefined;
  await forceGc();
  const aliveBeforeClear = weakRef.deref() !== undefined;

  trace.clear();
  await forceGc();
  const heapAfter = process.memoryUsage().heapUsed;
  const aliveAfterClear = weakRef.deref() !== undefined;

  return { heapBefore, heapAfter, aliveBeforeClear, aliveAfterClear, fixtureBytes };
}

interface ManifoldPhaseResult {
  entriesAlwaysZero: boolean;
  heapUsedMb: number[];
  slopeMbPerCall: number;
  fixtureBytes: number;
}

const MANIFOLD_CALLS = 10;

/** The auto-clear invariant at magnitude — see the file header's `manifold` description. */
async function manifoldPhase(): Promise<ManifoldPhaseResult> {
  const fixtureBytes = byteLength(flatBlob(FIXTURE_BYTES));
  const manifoldEnv = await buildManifoldEnv([fakeServer(async () => flatBlob(FIXTURE_BYTES))]);
  const tool = createManifoldTool(manifoldEnv, "CATALOG", { trace: manifoldEnv.trace });

  const heapUsedMb: number[] = [];
  let entriesAlwaysZero = true;
  for (let i = 0; i < MANIFOLD_CALLS; i++) {
    await tool.call({ expr: "(define r (t/fake))" });
    if (manifoldEnv.trace.stats().entries !== 0) entriesAlwaysZero = false;
    await forceGc();
    heapUsedMb.push(process.memoryUsage().heapUsed / (1024 * 1024));
  }

  const slopeMbPerCall = (heapUsedMb[MANIFOLD_CALLS - 1]! - heapUsedMb[0]!) / (MANIFOLD_CALLS - 1);
  return { entriesAlwaysZero, heapUsedMb, slopeMbPerCall, fixtureBytes };
}

async function main(): Promise<void> {
  if (typeof global.gc !== "function") {
    console.error("provenance-gc-release-child: must run with --expose-gc");
    process.exitCode = 1;
    return;
  }
  const direct = await directPhase();
  const manifold = await manifoldPhase();
  console.log(JSON.stringify({ direct, manifold }));
}

await main();
