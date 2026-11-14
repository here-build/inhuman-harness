import path from "node:path";

import { liveShapePkg, sqlitePkg } from "../lib/deps.mjs";
import { compareAgainstFloor, measureTimed, withTempDir } from "../lib/harness.mjs";

const { HarnessDatabase, UpdateLaneHub } = sqlitePkg;
const { LiveShape, createLocalShapeTransport } = liveShapePkg;

export async function runLiveShapeFanoutBench() {
  return await withTempDir("harness-bench-s02-", async (dir) => {
    const counts = [1, 10, 50];
    const results = {};

    for (const subscribers of counts) {
      // --- Theoretical Floor: single update map + JSON stringify + N Map observers ---
      const floorSessions = new Map();
      const now0 = Date.now();
      for (let i = 0; i < 40; i++) {
        floorSessions.set(`s-${i}`, {
          sessionId: `s-${i}`,
          title: `Session ${i}`,
          running: false,
          lastActiveAtMs: now0 - i * 1000,
        });
      }
      const subscriberMaps = Array.from({ length: subscribers }, () => new Map(floorSessions));
      let floorStep = 0;
      const floorStats = await measureTimed({
        warmup: 10,
        iterations: 150,
        fn: () => {
          const step = floorStep++;
          const targetId = `s-${step % 25}`;
          const updated = {
            sessionId: targetId,
            title: `Updated ${step}`,
            running: step % 2 === 0,
            lastActiveAtMs: now0 + step * 10,
          };
          floorSessions.set(targetId, updated);
          const wireFrame = JSON.stringify({
            kind: "shape/delta",
            subscriptionId: "recent",
            offset: step,
            upserts: [updated],
            deletes: [],
          });
          const parsed = JSON.parse(wireFrame);
          for (let j = 0; j < subscribers; j++) {
            const map = subscriberMaps[j];
            for (const row of parsed.upserts) {
              map.set(row.sessionId, row);
            }
          }
        },
      });

      // --- Actual Stack: HarnessDatabase -> UpdateLaneHub -> N LiveShape observers ---
      const db = new HarnessDatabase(path.join(dir, `fanout-${subscribers}.db`));
      const baseMs = Date.now();
      for (let i = 0; i < 40; i++) {
        db.insertSession({
          sessionId: `s-${i}`,
          title: `Session ${i}`,
          workspacePath: "/workspace/a",
          mode: "assistant",
          permissionMode: "manual",
          running: false,
          createdAtMs: baseMs - i * 1000,
          lastActiveAtMs: baseMs - i * 1000,
        });
      }

      const hub = new UpdateLaneHub(db);
      const shapes = [];
      for (let j = 0; j < subscribers; j++) {
        const transport = createLocalShapeTransport(hub, `client-${j}`);
        const shape = new LiveShape("recent_sessions", { limit: 25 }, "sessionId", undefined, transport);
        shape.connect();
        await shape.ready();
        shapes.push(shape);
      }

      let actualStep = 0;
      const actualStats = await measureTimed({
        warmup: 10,
        iterations: 150,
        fn: () => {
          const step = actualStep++;
          const targetId = `s-${step % 25}`;
          db.updateSession(targetId, {
            title: `Updated ${step}`,
            running: step % 2 === 0,
            lastActiveAtMs: baseMs + step * 10,
          });
        },
      });

      for (const s of shapes) s.dispose();
      db.close();

      results[`n_${subscribers}`] = {
        subscribers,
        floor: floorStats,
        actual: actualStats,
        ratio: compareAgainstFloor(floorStats, actualStats),
      };
    }

    return {
      suite: "02-live-shape-fanout",
      scenarios: results,
    };
  });
}
