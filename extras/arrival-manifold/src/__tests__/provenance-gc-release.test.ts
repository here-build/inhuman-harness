// provenance-gc-release — proves `EvalTrace.clear()` is not merely a no-op bookkeeping
// call but the ACT that frees real heap: the within-task OOM driver (see `manifold-tool.ts`'s
// `call()` `finally` and `provenance-arming.test.ts`) is a provenance point retaining a tool
// call's FULL boxed value forever. That fix is
// pinned at the STRUCTURE level (`trace.stats().entries === 0` after a call) by
// `provenance-arming.test.ts` already; this file pins it at the MEMORY level — a `WeakRef`
// taken on the exact retained object, proving it survives on the trace alone and dies once
// `clear()` runs, plus an actual `heapUsed` delta of the right magnitude.
//
// WHY A CHILD PROCESS: same reason as `heap-canary.test.ts` — the default vitest worker
// never gets `--expose-gc`, and an unforced GC makes both `process.memoryUsage().heapUsed`
// and a `WeakRef` deref noise, not signal. The measurement work
// (`provenance-gc-release-child.ts`) runs in a spawned `node --expose-gc` + tsx process,
// mirroring `heap-canary.test.ts`'s mechanism exactly (see that file's header for the full
// npx-vs-raw-node rationale).

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const childPath = fileURLToPath(new URL("provenance-gc-release-child.ts", import.meta.url));
// Absolute path, not a bare "npx" PATH lookup (sonarjs/no-os-command-from-path) — npx ships
// in the same directory as the running node binary in every supported layout (nvm, Volta,
// system installs, CI images). Same justification as `heap-canary.test.ts`'s `npxPath`.
const npxPath = path.join(path.dirname(process.execPath), "npx");

interface DirectPhaseResult {
  heapBefore: number;
  heapAfter: number;
  aliveBeforeClear: boolean;
  aliveAfterClear: boolean;
  fixtureBytes: number;
}

interface ManifoldPhaseResult {
  entriesAlwaysZero: boolean;
  heapUsedMb: number[];
  slopeMbPerCall: number;
  fixtureBytes: number;
}

interface ChildResult {
  direct: DirectPhaseResult;
  manifold: ManifoldPhaseResult;
}

/** GENEROUS on purpose, same posture as `heap-canary.test.ts`'s `MAX_GROWTH_MB`: this
 *  proves `clear()` released a MAJORITY of the fixture's real bytes, not a byte-exact
 *  accounting. The slack absorbs (a) UTF-16-code-unit-count vs V8's actual flat-string
 *  allocation (header + alignment padding on top of the raw 2-bytes/unit count), (b)
 *  whatever else is live on the heap moving between the two `heapUsed` snapshots (GC
 *  bookkeeping, the `AString` wrapper object itself, V8 background compaction), and (c)
 *  generational-GC promotion lag between the two forced-collection pairs. A REAL leak
 *  (the pre-fix behavior) releases ~0 bytes here, nowhere close to half the fixture — so
 *  0.5 stays a real, non-coincidental gate, not a rubber stamp. */
const RELEASE_FRACTION_MIN = 0.5;

/** Same posture as the `manifold` phase's own header comment: without the `finally`-clear
 *  in `manifold-tool.ts`'s `call()`, ten sequential 8MB-payload calls against one
 *  long-lived tool would grow heap ~8MB/call. A bound an order of magnitude below that
 *  claimed leak rate is still nowhere close to a false-negative risk band. */
const MANIFOLD_SLOPE_MAX_MB_PER_CALL = 1;

describe("provenance GC release — EvalTrace.clear() actually frees memory", () => {
  it("direct arming: the trace alone keeps a tool's retained value alive; clear() releases it", () => {
    // Invoked through `npx tsx` — see `heap-canary.test.ts`'s header for why (workspace
    // module resolution for `.ts` extensionless-remap imports needs tsx's loader, which a
    // raw `node --expose-gc <file>.ts` cannot do).
    const raw = execFileSync(npxPath, ["tsx", "--expose-gc", childPath], { encoding: "utf8" });
    const { direct, manifold } = JSON.parse(raw.trim()) as ChildResult;

    // Causality leg #1: after every OTHER reference (session scope's `define` binding,
    // the ambient) is dropped, the value is STILL ALIVE — something besides those refs is
    // retaining it. Given the only remaining holder is the trace, this pins the trace (not
    // the scope) as the retainer under test.
    expect(
      direct.aliveBeforeClear,
      "the provenance point's retained value died before clear() was even called — either " +
        "nothing minted a point, or the WeakRef target was wrong (should be the trace's own " +
        "retainer, independent of the session scope's `define` binding, which was already " +
        "dropped by this point).",
    ).toBe(true);

    // Causality leg #2: THE claim. Once `clear()` runs (with every other reference already
    // gone), the value is released.
    expect(
      direct.aliveAfterClear,
      "EvalTrace.clear() ran but the retained value is still reachable — clear() is not " +
        "actually dropping the provenance graph's strong reference to the tool's boxed result.",
    ).toBe(false);

    // Magnitude: real bytes came back, not just an id-bookkeeping no-op.
    const releasedBytes = direct.heapBefore - direct.heapAfter;
    const minExpectedBytes = direct.fixtureBytes * RELEASE_FRACTION_MIN;
    expect(
      releasedBytes,
      `clear() released ${(releasedBytes / 1024 / 1024).toFixed(2)}MB but the fixture was ` +
        `${(direct.fixtureBytes / 1024 / 1024).toFixed(2)}MB — expected at least ` +
        `${(RELEASE_FRACTION_MIN * 100).toFixed(0)}% of it back ` +
        `(heapBefore=${direct.heapBefore}, heapAfter=${direct.heapAfter}).`,
    ).toBeGreaterThanOrEqual(minExpectedBytes);

    // ── manifold level: the auto-clear invariant (manifold-tool.ts's call() finally) at
    // magnitude, through the full createManifoldTool + tool.call() path.
    expect(
      manifold.entriesAlwaysZero,
      "trace.stats().entries was non-zero after at least one of ten sequential calls — " +
        "manifold-tool.ts's call() finally is not clearing the trace on every call.",
    ).toBe(true);

    expect(
      manifold.slopeMbPerCall,
      `heap grew ${manifold.slopeMbPerCall.toFixed(2)}MB/call across ten sequential ` +
        `${(manifold.fixtureBytes / 1024 / 1024).toFixed(2)}MB-payload calls against one ` +
        `long-lived tool (series: ${manifold.heapUsedMb.map((v) => v.toFixed(2)).join(", ")}MB) — ` +
        "without the finally-clear this should grow roughly one fixture's worth per call.",
    ).toBeLessThan(MANIFOLD_SLOPE_MAX_MB_PER_CALL);
    // execFileSync throws on a non-zero child exit (and on a JSON.parse failure from
    // truncated/missing stdout) — reaching this point already proves a clean exit.
  }, 60_000);
});
