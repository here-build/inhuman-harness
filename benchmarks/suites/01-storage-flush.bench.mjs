import path from "node:path";

import { Database, sqlitePkg } from "../lib/deps.mjs";
import { compareAgainstFloor, flatTextOfBytes, measureTimed, round2, withTempDir } from "../lib/harness.mjs";
import { BenchToolCallNode, createBenchSessionContainer } from "../lib/models.mjs";

const { HarnessDatabase } = sqlitePkg;

export async function runStorageFlushBench() {
  return await withTempDir("harness-bench-s01-", async (dir) => {
    const initialTurns = 50;
    const callsPerTurn = 3; // 1 root + 50 turns + 150 calls = 201 nodes (~350-450 KB)

    // Prebuild immutable delta payload once for Initial Commit comparison
    const seedContainer = createBenchSessionContainer({
      sessionId: "seed",
      turnCount: initialTurns,
      callsPerTurn,
    });
    const seedDelta = seedContainer.takeNodeDelta();
    const rawPreSerializedRows = seedDelta.upserts.map((r) => ({
      id: `["s","${r.uuid}"]`,
      sessionId: "s",
      nodeId: r.uuid,
      tag: r.tag,
      isRoot: r.uuid === seedDelta.rootId ? 1 : 0,
      revision: seedDelta.revision,
      rowJson: JSON.stringify(r),
    }));
    const payloadBytes = rawPreSerializedRows.reduce((sum, r) => sum + Buffer.byteLength(r.rowJson), 0);
    seedContainer.destroy();

    // --- Part A: Initial Session Commit (201 nodes) ---
    let floorInitialIdx = 0;
    const floorDbPath = path.join(dir, "floor-init.db");
    const floorHarness = new HarnessDatabase(floorDbPath);
    floorHarness.close();
    const rawFloorDb = new Database(floorDbPath);
    rawFloorDb.pragma("journal_mode = WAL");
    rawFloorDb.pragma("synchronous = NORMAL");
    rawFloorDb.pragma("foreign_keys = ON");
    const insertSessRaw = rawFloorDb.prepare(
      `INSERT INTO sessions (session_id, title, workspace_path, mode, permission_mode, running, revision, created_at_ms, last_active_at_ms)
       VALUES (?, ?, '', 'assistant', 'manual', 1, 1, ?, ?)`,
    );
    const insertNodeRaw = rawFloorDb.prepare(
      `INSERT INTO session_nodes (id, session_id, node_id, tag, is_root, revision, row_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET tag=excluded.tag, is_root=excluded.is_root, revision=excluded.revision, row_json=excluded.row_json`,
    );
    const txFloorInit = rawFloorDb.transaction((sid, now, rows) => {
      insertSessRaw.run(sid, "Floor Bench", now, now);
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        insertNodeRaw.run(`["${sid}","${r.nodeId}"]`, sid, r.nodeId, r.tag, r.isRoot, r.revision, r.rowJson);
      }
    });

    const floorInitial = await measureTimed({
      warmup: 3,
      iterations: 20,
      fn: () => {
        const sid = `f-${floorInitialIdx++}`;
        txFloorInit(sid, Date.now(), rawPreSerializedRows);
      },
    });
    rawFloorDb.close();

    let actualInitialIdx = 0;
    const actualInitDb = new HarnessDatabase(path.join(dir, "actual-init.db"));
    const actualInitial = await measureTimed({
      warmup: 3,
      iterations: 20,
      fn: () => {
        const sid = `a-${actualInitialIdx++}`;
        const container = createBenchSessionContainer({
          sessionId: sid,
          turnCount: initialTurns,
          callsPerTurn,
        });
        const delta = container.takeNodeDelta();
        const now = Date.now();
        actualInitDb.writeTransaction(["sessions", "session_nodes"], (tx) => {
          actualInitDb.insertSession({
            sessionId: sid,
            title: "Actual Bench",
            workspacePath: "",
            mode: "assistant",
            permissionMode: "manual",
            running: true,
            revision: delta.revision,
            createdAtMs: now,
            lastActiveAtMs: now,
          });
          actualInitDb.commitSessionNodesInTx(tx, sid, delta);
        });
        container.destroy();
      },
    });
    actualInitDb.close();

    // --- Part B: Incremental Active-Turn Flush (O(delta) on 100-turn seeded session) ---
    const incIterations = 100;
    const floorIncPath = path.join(dir, "floor-inc.db");
    const floorSeedDb = new HarnessDatabase(floorIncPath);
    const baseSess = createBenchSessionContainer({
      sessionId: "inc-floor",
      turnCount: 100,
      callsPerTurn: 3,
    });
    floorSeedDb.insertSession({
      sessionId: "inc-floor",
      title: "Floor Inc",
      workspacePath: "",
      mode: "assistant",
      permissionMode: "manual",
      running: true,
      revision: 1,
      createdAtMs: Date.now(),
      lastActiveAtMs: Date.now(),
    });
    floorSeedDb.commitSessionNodes("inc-floor", baseSess.takeNodeDelta());
    const incSampleTurn = baseSess.root.turns.at(-1);
    const incTurnUuid = incSampleTurn.uuid;
    const incTurnRowJson = JSON.stringify({
      uuid: incTurnUuid,
      tag: "bench:session:turn",
      columns: {},
      state: {
        ordinal: incSampleTurn.ordinal,
        prompt: incSampleTurn.prompt,
        status: "running",
        responseText: incSampleTurn.responseText + flatTextOfBytes(256, "chunk"),
        responseThought: incSampleTurn.responseThought,
      },
      refs: {},
      refLists: {},
      children: {},
      childLists: { calls: [] },
      childRecords: {},
    });
    baseSess.destroy();
    floorSeedDb.close();

    const rawIncDb = new Database(floorIncPath);
    rawIncDb.pragma("journal_mode = WAL");
    rawIncDb.pragma("synchronous = NORMAL");
    const updSessRaw = rawIncDb.prepare(
      `UPDATE sessions SET revision = ?, last_active_at_ms = ? WHERE session_id = 'inc-floor'`,
    );
    const upsertNodeRaw = rawIncDb.prepare(
      `INSERT INTO session_nodes (id, session_id, node_id, tag, is_root, revision, row_json)
       VALUES (?, 'inc-floor', ?, 'bench:session:turn', 0, ?, ?)
       ON CONFLICT(id) DO UPDATE SET revision=excluded.revision, row_json=excluded.row_json`,
    );
    const txFloorInc = rawIncDb.transaction((rev, now, turnId, json1, callId, json2) => {
      updSessRaw.run(rev, now);
      upsertNodeRaw.run(`["inc-floor","${turnId}"]`, turnId, rev, json1);
      upsertNodeRaw.run(`["inc-floor","${callId}"]`, callId, rev, json2);
    });

    const incPayloads = Array.from({ length: incIterations + 15 }, (_, i) => ({
      turnJson: incTurnRowJson,
      callId: `call-${i}`,
      callJson: JSON.stringify({
        uuid: `call-${i}`,
        tag: "bench:session:tool-call",
        columns: {},
        state: { toolName: "read_file", status: "completed", outcomeText: `chunk-${i}` },
        refs: {},
        refLists: {},
        children: {},
        childLists: {},
        childRecords: {},
      }),
    }));

    let incFloorStep = 0;
    const floorIncremental = await measureTimed({
      warmup: 10,
      iterations: incIterations,
      fn: () => {
        const p = incPayloads[incFloorStep++];
        txFloorInc(incFloorStep + 1, Date.now(), incTurnUuid, p.turnJson, p.callId, p.callJson);
      },
    });
    rawIncDb.close();

    const actualIncDb = new HarnessDatabase(path.join(dir, "actual-inc.db"));
    const liveContainer = createBenchSessionContainer({
      sessionId: "inc-actual",
      turnCount: 100,
      callsPerTurn: 3,
    });
    actualIncDb.insertSession({
      sessionId: "inc-actual",
      title: "Actual Inc",
      workspacePath: "",
      mode: "assistant",
      permissionMode: "manual",
      running: true,
      revision: 1,
      createdAtMs: Date.now(),
      lastActiveAtMs: Date.now(),
    });
    actualIncDb.commitSessionNodes("inc-actual", liveContainer.takeNodeDelta());
    const lastTurn = liveContainer.root.turns.at(-1);

    let incActualStep = 0;
    const actualIncremental = await measureTimed({
      warmup: 10,
      iterations: incIterations,
      fn: () => {
        const step = incActualStep++;
        liveContainer.transact(() => {
          liveContainer.revision += 1;
          lastTurn.responseText = `Turn chunk ${step}: ${flatTextOfBytes(256, `delta-${step}`)}`;
          lastTurn.calls.push(
            new BenchToolCallNode({
              toolName: "read_file",
              status: "completed",
              argsJson: `{"path":"f-${step}.ts"}`,
              outcomeText: `outcome-${step}`,
              revision: liveContainer.revision,
            }),
          );
        });
        const delta = liveContainer.takeNodeDelta();
        actualIncDb.writeTransaction(["sessions", "session_nodes"], (tx) => {
          actualIncDb.updateSession("inc-actual", {
            revision: delta.revision,
            lastActiveAtMs: Date.now(),
          });
          actualIncDb.commitSessionNodesInTx(tx, "inc-actual", delta);
        });
      },
    });
    liveContainer.destroy();
    actualIncDb.close();

    return {
      suite: "01-storage-flush",
      initialCommit: {
        nodesCount: rawPreSerializedRows.length,
        payloadKb: round2(payloadBytes / 1024),
        floor: floorInitial,
        actual: actualInitial,
        ratio: compareAgainstFloor(floorInitial, actualInitial),
      },
      incrementalTurnFlush: {
        seededTurns: 100,
        floor: floorIncremental,
        actual: actualIncremental,
        ratio: compareAgainstFloor(floorIncremental, actualIncremental),
      },
    };
  });
}
