// heap-leak.bench — empirical build→use→drop memory harness for a manifold world. A
// caller that builds a FRESH manifold world per task (buildManifoldEnv → tool calls with
// multi-MB text responses → world abandoned) can exhaust node's heap after enough tasks
// if some component survives past the task that created it — this harness measures
// whether that happens, and if so, isolates which component.
//
// THIS FILE MEASURES, it does not assume. Four variants of the SAME build→use→drop
// cycle, run N=20 times each, heapUsed sampled (after a forced double-GC) at the end of
// every cycle:
//   a. drop-only            — the facade's ORIGINAL behavior (no ambient.dispose()).
//   b. + ambient.dispose()  — the designed teardown (facade.ts's already-patched intent).
//   c. (b) but trace OFF    — isolates EvalTrace retention from ambient retention.
//   d. (a) but 1KB responses — isolates response-SIZE dependence from a structural leak.
//
// A variant that PLATEAUS (near-zero slope) means the JS references genuinely drop and
// GC reclaims the world for that configuration (or growth is bounded by response size,
// per variant d). A variant that GROWS (slope persists across 20 cycles, not just noise)
// names an actual retained-per-cycle component.
//
// Run: npx tsx --expose-gc src/__benchmarks__/heap-leak.bench.ts
// (--expose-gc is REQUIRED — the harness refuses to run without it: an unforced GC makes
// every heapUsed sample noise, not a measurement.)

import { disposeRunContext } from "@here.build/arrival";

import { type BoundServer, buildManifoldEnv, type RemoteTool } from "../bind.js";
import { createManifoldTool } from "../manifold-tool.js";

const CYCLES = 20;
const CALLS_PER_CYCLE = 5;
const BIG_RESPONSE_BYTES = 2_000_000; // ~2MB — a real upstream tool's bulk text response shape
const SMALL_RESPONSE_BYTES = 1000; // ~1KB — variant (d)'s response-size-independence probe
const SLOPE_WINDOW = 15; // least-squares over the LAST 15 of 20 cycles (lets early-cycle
// warmup — first capability assembly, JIT, etc. — fall outside the fitted window)
const DESIGNED_TEARDOWN_SLOPE_BOUND_MB = 2; // the invariant this bench GATES: variant (b)
// (the designed teardown) must plateau under this bound, or the "facade must dispose" fix
// is not actually sufficient and something else is leaking.

/** A ~N-byte CSV-ish blob — same shape class as a real upstream tool's bulk text response
 *  (the shape this harness is built to catch: multi-MB text responses). MUST produce a genuinely
 *  FLAT string, not a lazy V8 ConsString rope: `row.repeat(n)` looks like it allocates
 *  ~N bytes but actually builds an unflattened cons-tree over the SAME short `row`
 *  backing buffer (V8 flattens only on-demand, e.g. on a regex/char scan — `.length` is
 *  O(1) and never triggers it), so a naive `.repeat()`-based fixture measures almost
 *  nothing no matter how "big" the string claims to be — confirmed empirically: 5×2MB
 *  via `.repeat()` cost ~0.00MB of heap; the SAME 5 strings via `Array(n).fill().join("")`
 *  cost ~9.5MB (the real, expected number). `.join("")` forces a single up-front flat
 *  allocation, so this fixture actually exercises the retention it claims to. */
function csvBlobOfBytes(bytes: number): string {
  const row = `id,name,value,note,${"x".repeat(64)}\n`; // ~85 bytes/row
  const rows = Math.max(1, Math.ceil(bytes / row.length));
  return Array.from({ length: rows }, () => row).join("");
}

const BIG_RESPONSE_FACTORY = (): string => csvBlobOfBytes(BIG_RESPONSE_BYTES);
const SMALL_RESPONSE_FACTORY = (): string => csvBlobOfBytes(SMALL_RESPONSE_BYTES);

/** ONE fake tool, slug `t` (so calls read `(t/fake)` — the shape a real upstream tool
 *  binds as). `invoke` builds a FRESH blob every call via `makeResponse`
 *  — a shared constant string here would let every "response" alias the SAME backing
 *  buffer across all 5 calls × 20 cycles, hiding the very per-call growth being
 *  measured (a real upstream tool never returns the identical string object twice). */
function fakeServer(makeResponse: () => string): BoundServer {
  const tool: RemoteTool = {
    name: "fake",
    description: "returns a fresh CSV-ish text blob",
    inputSchema: { type: "object", properties: {}, required: [] },
    invoke: async () => makeResponse(),
  };
  return { slug: "t", tools: [tool] };
}

interface Variant {
  key: string;
  label: string;
  dispose: boolean;
  trace: boolean;
  makeResponse: () => string;
}

const VARIANTS: readonly Variant[] = [
  {
    key: "a",
    label: "a: drop-only (facade original)",
    dispose: false,
    trace: true,
    makeResponse: BIG_RESPONSE_FACTORY,
  },
  {
    key: "b",
    label: "b: +ambient.dispose() (designed teardown)",
    dispose: true,
    trace: true,
    makeResponse: BIG_RESPONSE_FACTORY,
  },
  {
    key: "c",
    label: "c: (b) trace OFF (isolates EvalTrace)",
    dispose: true,
    trace: false,
    makeResponse: BIG_RESPONSE_FACTORY,
  },
  {
    key: "d",
    label: "d: (a) 1KB responses (isolates response-size)",
    dispose: false,
    trace: true,
    makeResponse: SMALL_RESPONSE_FACTORY,
  },
];

/** Asserted non-null by `main`'s `--expose-gc` guard before this is ever called. */
function forcedGc(): () => void {
  const gc = global.gc;
  if (!gc) throw new Error("forcedGc: global.gc is unavailable — call only after the --expose-gc guard passes");
  return gc;
}

async function forceGc(): Promise<void> {
  const gc = forcedGc();
  gc();
  // Let any pending microtask-queued finalization/weak-callback settle before the second
  // sweep — a single synchronous gc() call can miss objects freed by a promise
  // continuation that hasn't run yet.
  await new Promise((resolve) => setTimeout(resolve, 0));
  gc();
}

/** ONE build→use→drop cycle for `variant`. Every local (`server`, `manifoldEnv`, `tool`)
 *  is function-scoped and returned nowhere — once this function returns, nothing in the
 *  module keeps them reachable except whatever the variant's OWN mechanism (scope
 *  bindings inside the dropped env, EvalTrace entries inside the dropped trace) retains
 *  internally to itself. That internal retention only matters if the whole object graph
 *  is ALSO kept reachable from an external root — which, by construction, nothing here
 *  does. */
async function runCycle(variant: Variant): Promise<void> {
  const server = fakeServer(variant.makeResponse);
  const manifoldEnv = await buildManifoldEnv([server]);
  const tool = createManifoldTool(manifoldEnv, "CATALOG", {
    trace: variant.trace ? manifoldEnv.trace : undefined,
  });
  for (let i = 0; i < CALLS_PER_CYCLE; i++) {
    await tool.call({ expr: `(define r${i} (t/fake))` });
  }
  if (variant.dispose) {
    await disposeRunContext(manifoldEnv.runCtx);
  }
  // No `return manifoldEnv`/`tool`/`server` — they fall out of scope here.
}

/** Least-squares slope (MB/cycle) over the last `SLOPE_WINDOW` samples of `series`
 *  (cycle index on x, heapUsed-MB on y) — a plateaued series' slope is ~0; a genuinely
 *  growing one's slope tracks the per-cycle retained bytes directly. */
function lastWindowSlope(series: readonly number[], window: number): number {
  const tail = series.slice(-window);
  const n = tail.length;
  const xs = tail.map((_, i) => i);
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = tail.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i]! - meanX) * (tail[i]! - meanY);
    den += (xs[i]! - meanX) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

function mb(bytes: number): number {
  return bytes / (1024 * 1024);
}

async function main(): Promise<void> {
  if (typeof global.gc !== "function") {
    console.error(
      "heap-leak.bench: run with --expose-gc — e.g. `npx tsx --expose-gc src/__benchmarks__/heap-leak.bench.ts`. " +
        "Without a forced GC, process.memoryUsage().heapUsed is noise, not a measurement.",
    );
    process.exitCode = 1;
    return;
  }

  const heapByVariant = new Map<string, number[]>();

  for (const variant of VARIANTS) {
    console.error(`\n=== running ${variant.label} (${CYCLES} cycles) ===`);
    // Reset the process's heap baseline between variants — a clean double-GC before the
    // first cycle so one variant's residual (if any — that's exactly what we're
    // measuring) doesn't bias the NEXT variant's cycle-1 sample.
    await forceGc();
    const series: number[] = [];
    for (let cycle = 1; cycle <= CYCLES; cycle++) {
      await runCycle(variant);
      await forceGc();
      const heapUsedMb = mb(process.memoryUsage().heapUsed);
      series.push(heapUsedMb);
      console.error(`  cycle ${String(cycle).padStart(2)}: heapUsed=${heapUsedMb.toFixed(2)} MB`);
    }
    heapByVariant.set(variant.key, series);
  }

  // ── Compact table: cycle × variant heapUsed (MB) ──────────────────────────────────
  const header = ["cycle", ...VARIANTS.map((v) => v.key)];
  const rows: string[][] = [header];
  for (let i = 0; i < CYCLES; i++) {
    rows.push([String(i + 1), ...VARIANTS.map((v) => heapByVariant.get(v.key)![i]!.toFixed(2))]);
  }
  const widths = header.map((_, col) => Math.max(...rows.map((r) => r[col]!.length)));
  const line = (r: string[]) => r.map((cell, i) => cell.padStart(widths[i]!)).join("  ");

  console.log("\nheapUsed (MB) by cycle × variant:\n");
  console.log(line(rows[0]!));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const r of rows.slice(1)) console.log(line(r));

  // ── Slopes ─────────────────────────────────────────────────────────────────────────
  console.log(`\nleast-squares slope, MB/cycle, over the last ${SLOPE_WINDOW} of ${CYCLES} cycles:\n`);
  const slopes = new Map<string, number>();
  for (const variant of VARIANTS) {
    const slope = lastWindowSlope(heapByVariant.get(variant.key)!, SLOPE_WINDOW);
    slopes.set(variant.key, slope);
    console.log(`  ${variant.label}: ${slope >= 0 ? "+" : ""}${slope.toFixed(3)} MB/cycle`);
  }

  // ── Gate: the designed teardown (b) must plateau ──────────────────────────────────
  const bSlope = slopes.get("b")!;
  console.log(
    `\nGATE: variant (b) designed-teardown slope must be <= ${DESIGNED_TEARDOWN_SLOPE_BOUND_MB} MB/cycle — ` +
      `measured ${bSlope.toFixed(3)} MB/cycle.`,
  );
  if (bSlope > DESIGNED_TEARDOWN_SLOPE_BOUND_MB) {
    console.error(
      "FAIL: the designed teardown (ambient.dispose()) does not plateau — a component beyond " +
        "the ambient is retaining per-cycle memory. See variant (c) (trace OFF) to check whether " +
        "EvalTrace is the carrier.",
    );
    process.exitCode = 1;
  } else {
    console.log("PASS: designed teardown plateaus within bound.");
  }
}

await main();
