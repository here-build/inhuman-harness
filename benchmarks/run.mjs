import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { REPO_ROOT } from "./lib/deps.mjs";
import { systemMetadata } from "./lib/harness.mjs";
import { runStorageFlushBench } from "./suites/01-storage-flush.bench.mjs";
import { runLiveShapeFanoutBench } from "./suites/02-live-shape-fanout.bench.mjs";
import { runRemoteSessionLoadBench } from "./suites/03-remote-session-load.bench.mjs";
import { runClientMemoryBench } from "./suites/04-client-memory.bench.mjs";
import { runServerMultikernelDensityBench } from "./suites/05-server-multikernel-density.bench.mjs";

// Fail fast if --expose-gc was omitted.
if (typeof globalThis.gc !== "function") {
  console.error("benchmarks/run.mjs requires --expose-gc: `node --expose-gc benchmarks/run.mjs`");
  process.exit(1);
}

const meta = systemMetadata();
console.log(
  `Harness Benchmarks | Node ${meta.node} (V8 ${meta.v8}) | ${meta.platform} | ${meta.cpuModel} (${meta.cpuCores} cores, ${meta.totalMemGb} GB)`,
);

const s1 = await runStorageFlushBench();
const s2 = await runLiveShapeFanoutBench();
const s3 = await runRemoteSessionLoadBench();
const s4 = await runClientMemoryBench();
const s5 = await runServerMultikernelDensityBench();

const report = {
  meta,
  suites: {
    storageFlush: s1,
    liveShapeFanout: s2,
    remoteSessionLoad: s3,
    clientMemory: s4,
    serverMultikernelDensity: s5,
  },
};

function printRatioRow(label, ratio) {
  console.log(
    `  ${label.padEnd(36)} | floor p50=${String(ratio.floorP50Ms).padStart(7)}ms | actual p50=${String(ratio.actualP50Ms).padStart(7)}ms (p95=${String(ratio.actualP95Ms).padStart(7)}ms) | Omega=${String(ratio.overheadFactor).padStart(5)}x | Eff=${String(ratio.efficiencyPct).padStart(6)}%`,
  );
}

console.log("\n=== 1. Storage Flush (Actual vs Raw better-sqlite3 Ceiling) ===");
printRatioRow("Initial Commit (201 nodes)", s1.initialCommit.ratio);
printRatioRow("Incremental Turn Flush (delta)", s1.incrementalTurnFlush.ratio);

console.log("\n=== 2. Server LiveShape Fanout (Actual vs Raw Map Broadcast Ceiling) ===");
for (const key of Object.keys(s2.scenarios)) {
  const sc = s2.scenarios[key];
  printRatioRow(`recent_sessions (N=${sc.subscribers} peers)`, sc.ratio);
}

console.log("\n=== 3. Remote Session Load (WebSocket + Hydrate + First Computed Render) ===");
for (const key of Object.keys(s3.profiles)) {
  const pr = s3.profiles[key];
  printRatioRow(`${key} (${pr.nodeCount} nodes, ${pr.wireKb} KB)`, pr.ratio);
}
printRatioRow(`M Warm Delta (${s3.warmIncrementalCatchup.wireKb} KB)`, s3.warmIncrementalCatchup.ratio);

console.log("\n=== 4. Client Retained Memory & 20-Cycle Leak Slope ===");
for (const key of Object.keys(s4.footprint)) {
  const fp = s4.footprint[key];
  console.log(
    `  Size ${key.padEnd(2)} (${String(fp.nodeCount).padStart(4)} nodes, wire=${String(fp.wireMb).padStart(5)} MB) | JSON floor=${String(fp.floorHeapMb).padStart(5)} MB | Client Container=${String(fp.actualHeapMb).padStart(5)} MB | alpha=${fp.alphaMem}x | heap/wire=${fp.heapToWireRatio}x`,
  );
}
console.log(
  `  Session-switch leak slope (15-cycle tail): ${s4.sessionSwitchLeak.slopeMbPerCycle} MB/cycle (net=${s4.sessionSwitchLeak.netGrowthMb} MB, gate <= ${s4.sessionSwitchLeak.hardGateMaxSlopeMbPerCycle}) -> ${s4.sessionSwitchLeak.passed ? "PASS" : "FAIL"}`,
);

console.log("\n=== 5. Server Multi-Kernel Density (K=50 Active Kernels) & AsyncDispose Eviction ===");
console.log(
  `  Mount: ${s5.mountMsTotal}ms (${s5.mountMsPerKernel}ms/kernel) | Steady RAM: ${s5.totalHeapMb} MB total (${s5.mbPerKernel} MB/kernel) | Evict: ${s5.evictMsTotal}ms (${s5.evictMsPerKernel}ms/kernel) | Reclaimed: ${s5.reclaimedPct}% (residual=${s5.retainedAfterEvictMb} MB)`,
);

const baselineDir = path.resolve(REPO_ROOT, "benchmarks/baselines");
mkdirSync(baselineDir, { recursive: true });
const outPath = path.resolve(baselineDir, "latest.json");
writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`\nWrote baseline report to ${path.relative(REPO_ROOT, outPath)}`);

if (!s4.sessionSwitchLeak.passed) {
  console.error("BENCHMARK GATE FAILED: session-switch leak slope exceeded limit.");
  process.exit(1);
}
