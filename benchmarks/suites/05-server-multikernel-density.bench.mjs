import path from "node:path";

import { liveShapePkg, mobx, sqlitePkg } from "../lib/deps.mjs";
import { forceGc, mb, round2, round3, withTempDir } from "../lib/harness.mjs";
import { createBenchSessionContainer, tapeStats } from "../lib/models.mjs";

const { HarnessDatabase, UpdateLaneHub } = sqlitePkg;
const { LiveShape, createLocalShapeTransport } = liveShapePkg;
const { autorun, computed } = mobx;

export async function runServerMultikernelDensityBench() {
  return await withTempDir("harness-bench-s05-", async (dir) => {
    const kernelCount = 50;
    const turnsPerSession = 20;
    const callsPerTurn = 2; // ~60-80 KB state per active kernel

    const db = new HarnessDatabase(path.join(dir, "multi-kernel-agent.db"));
    const hub = new UpdateLaneHub(db);

    await forceGc();
    const heapBefore = process.memoryUsage().heapUsed;
    const rssBefore = process.memoryUsage().rss;

    const registry = new Map();
    const mountStart = performance.now();

    for (let k = 0; k < kernelCount; k++) {
      const kernelId = `tenant-kernel-${k}`;
      const sessionId = `sess-${k}`;
      const container = createBenchSessionContainer({
        sessionId,
        turnCount: turnsPerSession,
        callsPerTurn,
      });
      const now = Date.now();
      db.insertSession({
        sessionId,
        title: `Kernel ${k} Active`,
        workspacePath: `/virtual/${kernelId}`,
        mode: "assistant",
        permissionMode: "manual",
        running: true,
        revision: container.revision,
        createdAtMs: now,
        lastActiveAtMs: now,
      });
      db.commitSessionNodes(sessionId, container.takeNodeDelta());

      const transport = createLocalShapeTransport(hub, kernelId);
      const recentShape = new LiveShape("recent_sessions", { limit: 10 }, "sessionId", undefined, transport);
      recentShape.connect();

      const view = computed(() => tapeStats(container.root));
      let latest = null;
      const stopAutorun = autorun(() => {
        latest = view.get();
      });

      registry.set(kernelId, {
        kernelId,
        sessionId,
        container,
        recentShape,
        latest,
        async [Symbol.asyncDispose]() {
          const remaining = container.takeNodeDelta();
          if (remaining.upserts.length > 0 || remaining.deletes.length > 0) {
            db.commitSessionNodes(sessionId, remaining);
          }
          db.updateSession(sessionId, { running: false, lastActiveAtMs: Date.now() });
          stopAutorun();
          recentShape.dispose();
          container[Symbol.dispose]();
        },
      });
    }

    const mountMsTotal = round3(performance.now() - mountStart);
    await forceGc();
    const heapAfterMount = process.memoryUsage().heapUsed;
    const rssAfterMount = process.memoryUsage().rss;

    const totalHeapMb = mb(Math.max(0, heapAfterMount - heapBefore));
    const totalRssMb = mb(Math.max(0, rssAfterMount - rssBefore));
    const mbPerKernel = round3(totalHeapMb / kernelCount);

    // Deterministic AsyncDisposable eviction across all 50 active kernels
    const evictStart = performance.now();
    for (const [kernelId, entry] of [...registry.entries()]) {
      await entry[Symbol.asyncDispose]();
      registry.delete(kernelId);
    }
    const evictMsTotal = round3(performance.now() - evictStart);
    const evictMsPerKernel = round3(evictMsTotal / kernelCount);

    await forceGc();
    const heapAfterEvict = process.memoryUsage().heapUsed;
    const retainedAfterEvictMb = mb(Math.max(0, heapAfterEvict - heapBefore));
    const reclaimedPct =
      totalHeapMb > 0 ? round2(((totalHeapMb - retainedAfterEvictMb) / totalHeapMb) * 100) : 100;

    db.close();

    return {
      suite: "05-server-multikernel-density",
      kernelCount,
      turnsPerSession,
      mountMsTotal,
      mountMsPerKernel: round3(mountMsTotal / kernelCount),
      totalHeapMb,
      totalRssMb,
      mbPerKernel,
      evictMsTotal,
      evictMsPerKernel,
      retainedAfterEvictMb,
      reclaimedPct,
    };
  });
}
