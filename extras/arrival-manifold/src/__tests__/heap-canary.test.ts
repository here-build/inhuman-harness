// heap-canary — FAST default-gate regression guard for the finding in
// `../__benchmarks__/heap-leak.bench.ts`: a build→use→drop manifold-world cycle (no
// `ambient.dispose()` — the worst-case caller shape) should plateau under GC, not grow
// per cycle. The full bench (20 cycles, 2MB responses, 4 variants, least-squares slope)
// is opt-in per `.claude/rules/tests.md`; this is its 6-cycle/tiny-payload sibling, cheap
// enough to run on every `pnpm test`.
//
// WHY A CHILD PROCESS (not `global.gc()` in-process): the default vitest gate's OWN
// process never gets `--expose-gc` (changing the shared `vitest.config.ts` to add it
// would affect every test in this package, for one canary's sake) — and an unforced GC
// makes `process.memoryUsage().heapUsed` noise, not a signal (a coincidental collection
// mid-run would as easily hide a real leak as an absent one would fabricate one). The
// actual measurement work (`heap-canary-child.ts`) runs in a spawned
// `node --expose-gc` + tsx process instead — the SAME mechanism `heap-leak.bench.ts`
// itself requires, just automated here rather than a human running the command.
//
// GENEROUS bound, not precise: this catches an EGREGIOUS regression (a genuinely new
// per-cycle retention, MBs per cycle) — it does not attempt the bench file's
// least-squares slope precision. Cycle 1 is EXCLUDED from the growth check (capability
// assembly / JIT warm-up genuinely costs a few hundred KB the very first time; that is
// not what this canary is guarding against).

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const childPath = fileURLToPath(new URL("heap-canary-child.ts", import.meta.url));
// Absolute path, not a bare "npx" PATH lookup (sonarjs/no-os-command-from-path) — npx
// ships in the same directory as the running node binary in every supported layout
// (nvm, Volta, system installs, CI images).
const npxPath = path.join(path.dirname(process.execPath), "npx");

/** Growth bound across cycles 2→6 (5 deltas), MB. Generous on purpose (see file header) —
 *  the point is catching a leak measured in MB/cycle, not policing sub-MB noise. */
const MAX_GROWTH_MB = 10;

describe("heap canary — build→use→drop plateaus under GC (no dispose, tiny payloads)", () => {
  it("heapUsed does not grow materially from cycle 2 to cycle 6", () => {
    // Invoked through `npx tsx` — the SAME mechanism `heap-leak.bench.ts`'s own "Run:"
    // line documents. A raw `node --expose-gc <file>.ts` cannot resolve this package's
    // `../bind.js` → `bind.ts` extension remap (tsx's loader does that); `npx` finds the
    // workspace-hoisted `tsx` binary without a hardcoded path into node_modules/.pnpm.
    const raw = execFileSync(npxPath, ["tsx", "--expose-gc", childPath], { encoding: "utf8" });
    const heapUsedMb = JSON.parse(raw.trim()) as number[];
    expect(heapUsedMb).toHaveLength(6);

    // Cycle 1 excluded (see file header — first-run warm-up is not the regression this
    // guards against). Growth = last cycle minus cycle 2 (index 1), the plainest
    // "did it keep climbing" signal a generous bound can gate on without needing the
    // bench file's least-squares fit.
    const growthMb = heapUsedMb[5]! - heapUsedMb[1]!;
    expect(
      growthMb,
      `heapUsed grew ${growthMb.toFixed(2)}MB from cycle 2 to cycle 6 (series: ${heapUsedMb.map((v) => v.toFixed(2)).join(", ")}MB) — ` +
        `a build→use→drop cycle should plateau under GC even without ambient.dispose(). ` +
        `Re-run the full harness for detail: npx tsx --expose-gc src/__benchmarks__/heap-leak.bench.ts`,
    ).toBeLessThan(MAX_GROWTH_MB);
  }, 30_000);
});
