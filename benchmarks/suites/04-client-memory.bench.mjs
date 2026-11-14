import { liveShapePkg, mobx, modelPkg } from "../lib/deps.mjs";
import { compareAgainstFloor, forceGc, lastWindowSlope, mb, round2, round3 } from "../lib/harness.mjs";
import { BenchSessionRoot, createBenchSessionContainer, tapeStats } from "../lib/models.mjs";

const { DocumentContainer } = modelPkg;
const { applyNodeShapeDelta } = liveShapePkg;
const { autorun, computed } = mobx;

function buildSerializedRowsJson(turnCount, callsPerTurn, seed) {
  const c = createBenchSessionContainer({
    sessionId: `mem-${seed}`,
    turnCount,
    callsPerTurn,
  });
  const delta = c.takeNodeDelta();
  const rows = delta.upserts.map((u) => ({
    id: `["mem-${seed}","${u.uuid}"]`,
    sessionId: `mem-${seed}`,
    nodeId: u.uuid,
    tag: u.tag,
    isRoot: u.uuid === delta.rootId ? 1 : 0,
    revision: delta.revision,
    rowJson: JSON.stringify(u),
  }));
  const json = JSON.stringify({ upserts: rows, deletes: [], reset: true });
  c.destroy();
  return {
    json,
    wireBytes: Buffer.byteLength(json),
    nodeCount: rows.length,
  };
}

function retainFloorFromJson(wireJson) {
  const parsed = JSON.parse(wireJson);
  const byId = new Map();
  for (let i = 0; i < parsed.upserts.length; i++) {
    const row = parsed.upserts[i];
    const node = JSON.parse(row.rowJson);
    byId.set(node.uuid, node);
  }
  return byId;
}

function retainActualFromJson(wireJson, sessionId) {
  const delta = JSON.parse(wireJson);
  const container = new DocumentContainer(new BenchSessionRoot({ sessionId }), {
    guid: sessionId,
    readOnly: true,
  });
  applyNodeShapeDelta(container, delta);
  const view = computed(() => tapeStats(container.root));
  let latestStats = null;
  const stopAutorun = autorun(() => {
    latestStats = view.get();
  });
  return {
    container,
    latestStats,
    dispose() {
      stopAutorun();
      container[Symbol.dispose]();
    },
  };
}

export async function runClientMemoryBench() {
  const profiles = [
    { key: "S", turnCount: 10, callsPerTurn: 3, copies: 10 },
    { key: "M", turnCount: 100, callsPerTurn: 3, copies: 3 },
    { key: "L", turnCount: 400, callsPerTurn: 3, copies: 2 },
  ];

  const footprint = {};

  for (const p of profiles) {
    // Prepare serialized frames once so wire payload sizes match across floor and actual.
    const frames = Array.from({ length: p.copies }, (_, idx) =>
      buildSerializedRowsJson(p.turnCount, p.callsPerTurn, `${p.key}-${idx}`),
    );
    const wireMbPerSession = mb(frames[0].wireBytes);

    await forceGc();
    const baseFloorHeap = process.memoryUsage().heapUsed;
    let retainedFloor = frames.map((f) => retainFloorFromJson(f.json));
    await forceGc();
    const afterFloorHeap = process.memoryUsage().heapUsed;
    const floorBytesPerSession = Math.max(0, (afterFloorHeap - baseFloorHeap) / p.copies);
    retainedFloor.length = 0;
    retainedFloor = null;
    await forceGc();

    await forceGc();
    const baseActualHeap = process.memoryUsage().heapUsed;
    let retainedActual = frames.map((f, idx) => retainActualFromJson(f.json, `mem-${p.key}-${idx}`));
    await forceGc();
    const afterActualHeap = process.memoryUsage().heapUsed;
    const actualBytesPerSession = Math.max(0, (afterActualHeap - baseActualHeap) / p.copies);
    for (const h of retainedActual) h.dispose();
    retainedActual.length = 0;
    retainedActual = null;
    await forceGc();

    const floorMb = mb(floorBytesPerSession);
    const actualMb = mb(actualBytesPerSession);
    const alphaMem = floorMb > 0 ? round2(actualMb / floorMb) : 0;
    const wireAmp = wireMbPerSession > 0 ? round2(actualMb / wireMbPerSession) : 0;

    footprint[p.key] = {
      turnCount: p.turnCount,
      nodeCount: frames[0].nodeCount,
      copiesAveraged: p.copies,
      wireMb: wireMbPerSession,
      floorHeapMb: floorMb,
      actualHeapMb: actualMb,
      alphaMem,
      heapToWireRatio: wireAmp,
    };
  }

  // --- 20-Cycle Session-Switch Leak Bench (size M: 100 turns / ~0.9 MB) ---
  const cycles = 20;
  const leakSeriesMb = [];
  await forceGc();
  const baselineMb = mb(process.memoryUsage().heapUsed);

  for (let c = 0; c < cycles; c++) {
    const frame = buildSerializedRowsJson(100, 3, `leak-${c}`);
    const held = retainActualFromJson(frame.json, `leak-${c}`);
    if (held.latestStats?.turns !== 100) {
      throw new Error(`leak bench cycle ${c} expected 100 turns`);
    }
    held.dispose();
    await forceGc();
    leakSeriesMb.push(mb(process.memoryUsage().heapUsed));
  }

  const slopeMbPerCycle = lastWindowSlope(leakSeriesMb, 15);
  const netGrowthMb = round3(leakSeriesMb.at(-1) - leakSeriesMb[4]);

  return {
    suite: "04-client-memory",
    footprint,
    sessionSwitchLeak: {
      cycles,
      windowCycles: 15,
      baselineMb,
      finalMb: leakSeriesMb.at(-1),
      slopeMbPerCycle,
      netGrowthMb,
      hardGateMaxSlopeMbPerCycle: 0.5,
      passed: slopeMbPerCycle <= 0.5,
      seriesMb: leakSeriesMb,
    },
    ratioPlaceholder: compareAgainstFloor({ p50Ms: 1, p95Ms: 1 }, { p50Ms: 1, p95Ms: 1 }),
  };
}
