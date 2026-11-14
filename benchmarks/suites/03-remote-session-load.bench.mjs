import path from "node:path";

import { liveShapePkg, mobx, modelPkg, sqlitePkg, WebSocket, WebSocketServer } from "../lib/deps.mjs";
import { compareAgainstFloor, flatTextOfBytes, measureTimed, round2, withTempDir } from "../lib/harness.mjs";
import { BenchSessionRoot, createBenchSessionContainer, tapeStats } from "../lib/models.mjs";

const { DocumentContainer } = modelPkg;
const { HarnessDatabase } = sqlitePkg;
const { applyNodeShapeDelta } = liveShapePkg;
const { computed } = mobx;

function wsRequest(ws, reqObj) {
  return new Promise((resolve, reject) => {
    const onMessage = (raw) => {
      cleanup();
      resolve(raw.toString("utf8"));
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      ws.off("message", onMessage);
      ws.off("error", onError);
    };
    ws.on("message", onMessage);
    ws.on("error", onError);
    ws.send(JSON.stringify(reqObj));
  });
}

export async function runRemoteSessionLoadBench() {
  return await withTempDir("harness-bench-s03-", async (dir) => {
    const db = new HarnessDatabase(path.join(dir, "remote.db"));
    const profiles = [
      { key: "S", turnCount: 10, callsPerTurn: 3, warmup: 3, iterations: 20, simulatedWanHalfRttMs: 0 },
      { key: "M", turnCount: 100, callsPerTurn: 3, warmup: 3, iterations: 15, simulatedWanHalfRttMs: 0 },
      { key: "L", turnCount: 400, callsPerTurn: 3, warmup: 2, iterations: 8, simulatedWanHalfRttMs: 0 },
      { key: "M_wan40ms", turnCount: 100, callsPerTurn: 3, warmup: 2, iterations: 8, simulatedWanHalfRttMs: 20 },
    ];

    const sessionSizes = {};
    for (const p of profiles) {
      const sid = `sess-${p.key}`;
      if (!sessionSizes[sid]) {
        const container = createBenchSessionContainer({
          sessionId: sid,
          turnCount: p.turnCount,
          callsPerTurn: p.callsPerTurn,
        });
        const delta = container.takeNodeDelta();
        const now = Date.now();
        db.insertSession({
          sessionId: sid,
          title: `Remote ${p.key}`,
          workspacePath: "/ws",
          mode: "assistant",
          permissionMode: "manual",
          running: false,
          revision: delta.revision,
          createdAtMs: now,
          lastActiveAtMs: now,
        });
        db.commitSessionNodes(sid, delta);
        const rows = db.listSessionNodeRows(sid);
        const wireBytes = Buffer.byteLength(JSON.stringify({ kind: "shape/delta", subscriptionId: sid, offset: 1, upserts: rows, deletes: [], reset: true }));
        sessionSizes[sid] = { nodeCount: rows.length, wireKb: round2(wireBytes / 1024) };
        container.destroy();
      }
    }

    const rawSelectStmt = db.sqlite.prepare(
      `SELECT id, session_id AS sessionId, node_id AS nodeId, tag, is_root AS isRoot, revision, row_json AS rowJson
       FROM session_nodes WHERE session_id = ?`,
    );

    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise((resolve) => wss.once("listening", resolve));
    const { port } = wss.address();

    wss.on("connection", (socket) => {
      socket.on("message", async (raw) => {
        const req = JSON.parse(raw.toString("utf8"));
        if (req.delayHalfRttMs > 0) {
          await new Promise((r) => setTimeout(r, req.delayHalfRttMs));
        }
        if (req.kind === "floor-load") {
          const rows = rawSelectStmt.all(req.sessionId);
          socket.send(JSON.stringify({ kind: "floor", rows }));
        } else if (req.kind === "actual-load") {
          const rows = db.listSessionNodeRows(req.sessionId);
          socket.send(
            JSON.stringify({
              kind: "shape/delta",
              subscriptionId: req.sessionId,
              offset: db.commitOffset,
              upserts: rows,
              deletes: [],
              reset: true,
            }),
          );
        } else if (req.kind === "actual-warm-delta") {
          socket.send(
            JSON.stringify({
              kind: "shape/delta",
              subscriptionId: req.sessionId,
              offset: db.commitOffset + 1,
              upserts: req.patchRows,
              deletes: [],
              reset: false,
            }),
          );
        }
      });
    });

    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });

    const profileResults = {};
    for (const p of profiles) {
      const sid = `sess-${p.key}`;
      const halfDelay = p.simulatedWanHalfRttMs;

      const floorStats = await measureTimed({
        warmup: p.warmup,
        iterations: p.iterations,
        fn: async () => {
          const payload = await wsRequest(ws, { kind: "floor-load", sessionId: sid, delayHalfRttMs: halfDelay });
          if (halfDelay > 0) await new Promise((r) => setTimeout(r, halfDelay));
          const frame = JSON.parse(payload);
          let chars = 0;
          const byId = new Map();
          for (let i = 0; i < frame.rows.length; i++) {
            const row = frame.rows[i];
            const parsed = JSON.parse(row.rowJson);
            byId.set(parsed.uuid, parsed);
            const st = parsed.state;
            if (typeof st.prompt === "string") chars += st.prompt.length + (st.responseText?.length ?? 0);
            if (typeof st.outcomeText === "string") chars += st.outcomeText.length;
          }
          if (chars === 0 && byId.size === 0) throw new Error("unexpected empty floor decode");
        },
      });

      const actualStats = await measureTimed({
        warmup: p.warmup,
        iterations: p.iterations,
        fn: async () => {
          const payload = await wsRequest(ws, { kind: "actual-load", sessionId: sid, delayHalfRttMs: halfDelay });
          if (halfDelay > 0) await new Promise((r) => setTimeout(r, halfDelay));
          const delta = JSON.parse(payload);
          const container = new DocumentContainer(new BenchSessionRoot({ sessionId: sid }), {
            guid: sid,
            readOnly: true,
          });
          applyNodeShapeDelta(container, delta);
          const summary = computed(() => tapeStats(container.root));
          const stats = summary.get();
          if (stats.turns !== p.turnCount) {
            throw new Error(`expected ${p.turnCount} turns, got ${stats.turns}`);
          }
          container.destroy();
        },
      });

      profileResults[p.key] = {
        turnCount: p.turnCount,
        nodeCount: sessionSizes[sid].nodeCount,
        wireKb: sessionSizes[sid].wireKb,
        simulatedRttMs: p.simulatedWanHalfRttMs * 2,
        floor: floorStats,
        actual: actualStats,
        ratio: compareAgainstFloor(floorStats, actualStats),
      };
    }

    // Warm incremental delta catch-up over WebSocket on already-hydrated M session
    const warmRows = db.listSessionNodeRows("sess-M");
    const warmDeltaFrame = { upserts: warmRows, deletes: [], reset: true };
    const warmContainer = new DocumentContainer(new BenchSessionRoot({ sessionId: "sess-M" }), {
      guid: "sess-M",
      readOnly: true,
    });
    applyNodeShapeDelta(warmContainer, warmDeltaFrame);
    const rootParsedRow = JSON.parse(warmRows.find((r) => Boolean(r.isRoot)).rowJson);
    const patchTurnId = `warm-turn-${Date.now()}`;
    const patchTurnRow = {
      uuid: patchTurnId,
      tag: "bench:session:turn",
      columns: {},
      state: {
        ordinal: 101,
        prompt: flatTextOfBytes(200, "warm-p"),
        status: "completed",
        responseText: flatTextOfBytes(1200, "warm-r"),
        responseThought: flatTextOfBytes(300, "warm-th"),
      },
      refs: {},
      refLists: {},
      children: {},
      childLists: { calls: [] },
      childRecords: {},
    };
    const nextRootRow = {
      ...rootParsedRow,
      childLists: {
        ...rootParsedRow.childLists,
        turns: [...rootParsedRow.childLists.turns, patchTurnId],
      },
    };
    const warmPatchRows = [
      { id: "r", sessionId: "sess-M", nodeId: rootParsedRow.uuid, tag: rootParsedRow.tag, isRoot: 1, revision: 99, rowJson: JSON.stringify(nextRootRow) },
      { id: "t", sessionId: "sess-M", nodeId: patchTurnId, tag: patchTurnRow.tag, isRoot: 0, revision: 99, rowJson: JSON.stringify(patchTurnRow) },
    ];

    const warmDeltaFloor = await measureTimed({
      warmup: 5,
      iterations: 50,
      fn: async () => {
        const raw = await wsRequest(ws, { kind: "actual-warm-delta", sessionId: "sess-M", patchRows: warmPatchRows, delayHalfRttMs: 0 });
        const msg = JSON.parse(raw);
        for (const row of msg.upserts) JSON.parse(row.rowJson);
      },
    });

    const warmSummary = computed(() => tapeStats(warmContainer.root));
    const warmDeltaActual = await measureTimed({
      warmup: 5,
      iterations: 50,
      fn: async (i) => {
        const raw = await wsRequest(ws, { kind: "actual-warm-delta", sessionId: "sess-M", patchRows: warmPatchRows, delayHalfRttMs: 0 });
        const delta = JSON.parse(raw);
        applyNodeShapeDelta(warmContainer, delta);
        const s = warmSummary.get();
        if (s.turns < 100 && i >= 0) throw new Error("unexpected turn count");
      },
    });
    warmContainer.destroy();

    ws.close();
    await new Promise((resolve) => wss.close(resolve));
    db.close();

    return {
      suite: "03-remote-session-load",
      profiles: profileResults,
      warmIncrementalCatchup: {
        baseTurns: 100,
        patchNodes: 2,
        wireKb: round2(Buffer.byteLength(JSON.stringify(warmPatchRows)) / 1024),
        floor: warmDeltaFloor,
        actual: warmDeltaActual,
        ratio: compareAgainstFloor(warmDeltaFloor, warmDeltaActual),
      },
    };
  });
}
