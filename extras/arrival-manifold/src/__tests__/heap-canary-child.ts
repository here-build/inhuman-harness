// heap-canary-child — the actual work `heap-canary.test.ts` measures, run in a CHILD
// process (spawned with `--expose-gc`) because the default vitest gate's own process does
// not get that flag, and an unforced GC makes `process.memoryUsage().heapUsed` noise, not
// a signal (see `../__benchmarks__/heap-leak.bench.ts`'s header for the full rationale —
// this file is that harness's fast/small/6-cycle sibling, DROP-ONLY variant only, the
// worst case a caller is most likely to actually hit: build a world, use it, let it fall
// out of scope, never call `ambient.dispose()`).
//
// Prints ONE line of JSON (an array of per-cycle heapUsed-MB numbers) to stdout — the
// parent test parses it. Never imported directly by a `.test.ts` file (spawning is the
// point: a forced GC needs the flag on ITS OWN process, not the vitest worker's).

import { type BoundServer, buildManifoldEnv, type RemoteTool } from "../bind.js";
import { createManifoldTool } from "../manifold-tool.js";

const CYCLES = 6;
const CALLS_PER_CYCLE = 5;
const RESPONSE_BYTES = 2000; // SMALL payload — this canary probes STRUCTURE (does a
// dropped world get reclaimed at all), not response-size scaling (the bench file's job).

/** Same `.repeat()` pitfall documented in `heap-leak.bench.ts`: `.repeat()` builds a lazy
 *  V8 ConsString rope over the short source substring, which barely costs any real heap
 *  no matter the claimed length — `Array.from({length}, () => row).join("")` forces one
 *  real flat allocation, which is the whole point of a heap-retention probe. */
function tinyBlob(bytes: number): string {
  const row = "id,name,value,note,x\n"; // ~22 bytes/row
  const rows = Math.max(1, Math.ceil(bytes / row.length));
  return Array.from({ length: rows }, () => row).join("");
}

function fakeServer(): BoundServer {
  const tool: RemoteTool = {
    name: "fake",
    inputSchema: { type: "object", properties: {}, required: [] },
    invoke: async () => tinyBlob(RESPONSE_BYTES),
  };
  return { slug: "t", tools: [tool] };
}

async function forceGc(): Promise<void> {
  const gc = global.gc;
  if (!gc) throw new Error("heap-canary-child: forceGc called without --expose-gc");
  gc();
  await new Promise((resolve) => setTimeout(resolve, 0));
  gc();
}

/** ONE build→use→DROP-ONLY cycle — no `ambient.dispose()` (the facade's original, and
 *  still the most common caller shape: nothing guarantees a caller remembers to dispose,
 *  so the package's OWN GC-reachability discipline is what actually has to hold). */
async function runCycle(): Promise<void> {
  const server = fakeServer();
  const manifoldEnv = await buildManifoldEnv([server]);
  const tool = createManifoldTool(manifoldEnv, "CATALOG", { trace: manifoldEnv.trace });
  for (let i = 0; i < CALLS_PER_CYCLE; i++) {
    await tool.call({ expr: `(define r${i} (t/fake))` });
  }
}

async function main(): Promise<void> {
  if (typeof global.gc !== "function") {
    console.error("heap-canary-child: must run with --expose-gc");
    process.exitCode = 1;
    return;
  }
  const heapUsedMb: number[] = [];
  await forceGc();
  for (let cycle = 0; cycle < CYCLES; cycle++) {
    await runCycle();
    await forceGc();
    heapUsedMb.push(process.memoryUsage().heapUsed / (1024 * 1024));
  }
  console.log(JSON.stringify(heapUsedMb));
}

await main();
