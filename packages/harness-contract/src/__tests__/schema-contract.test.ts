import { DatabaseSync } from "node:sqlite";

import { getTableConfig } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";

import {
  activeSessionsLaneParamsSchema,
  bootstrapHarnessSqliteSql,
  childSessionsLaneParamsSchema,
  HARNESS_SQLITE_DDL,
  kernelMetaLaneParamsSchema,
  kernelStateTable,
  modelPatchSchema,
  pendingAsksLaneParamsSchema,
  pendingAsksTable,
  recentSessionsLaneParamsSchema,
  serializedSessionDocumentSchema,
  sessionAttachFrameSchema,
  sessionBlobsTable,
  sessionDetachFrameSchema,
  sessionEffectsTable,
  sessionsTable,
  sessionSyncFrameSchema,
  sessionTurnsTable,
  sessionUpdatesTable,
  shapeDeltaFrameSchema,
  shapeSubscribeFrameSchema,
  shapeUnsubscribeFrameSchema,
  type SerializedSessionDocument,
  type SessionSyncFrame,
} from "../index.js";

describe("schema and wire contract", () => {
  describe("Drizzle table metadata vs SQLite DDL", () => {
    const allTables = [
      kernelStateTable,
      sessionsTable,
      pendingAsksTable,
      sessionTurnsTable,
      sessionUpdatesTable,
      sessionEffectsTable,
      sessionBlobsTable,
    ];

    it("initializes SQLite cleanly with bootstrapHarnessSqliteSql and matches Drizzle table metadata", () => {
      const db = new DatabaseSync(":memory:");
      db.exec(bootstrapHarnessSqliteSql);

      const tableRows = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all() as { name: string }[];
      const actualTableNames = tableRows.map((r) => r.name);

      const drizzleConfigs = allTables.map((t) => getTableConfig(t));
      const expectedTableNames = drizzleConfigs.map((c) => c.name).sort();

      expect(actualTableNames).toEqual(expectedTableNames);

      for (const config of drizzleConfigs) {
        const columnsInfo = db.prepare(`PRAGMA table_info(${config.name})`).all() as {
          name: string;
          pk: number;
        }[];

        const actualColNames = columnsInfo.map((c) => c.name);
        const expectedColNames = config.columns.map((c) => c.name);
        expect(actualColNames, `Columns for ${config.name}`).toEqual(expectedColNames);

        const actualPkCols = columnsInfo
          .filter((c) => c.pk > 0)
          .sort((a, b) => a.pk - b.pk)
          .map((c) => c.name);

        const singlePkCols = config.columns.filter((c) => c.primary).map((c) => c.name);
        const compositePkCols = config.primaryKeys.flatMap((pk) => pk.columns.map((c) => c.name));
        const expectedPkCols = singlePkCols.length > 0 ? singlePkCols : compositePkCols;
        expect(actualPkCols, `Primary key for ${config.name}`).toEqual(expectedPkCols);

        const userIndexes = (
          db.prepare(`PRAGMA index_list(${config.name})`).all() as { name: string; origin: string }[]
        ).filter((idx) => idx.origin === "c");

        const actualIndexes = userIndexes
          .map((idx) => {
            const cols = db.prepare(`PRAGMA index_info(${idx.name})`).all() as { name: string; seqno: number }[];
            return {
              name: idx.name,
              columns: cols.sort((a, b) => a.seqno - b.seqno).map((c) => c.name),
            };
          })
          .sort((a, b) => a.name.localeCompare(b.name));

        const expectedIndexes = config.indexes
          .map((idx) => ({
            name: idx.config.name,
            columns: idx.config.columns.map((c) => ("name" in c ? c.name : String(c))),
          }))
          .sort((a, b) => a.name.localeCompare(b.name));

        expect(actualIndexes, `Indexes for ${config.name}`).toEqual(expectedIndexes);
      }
    });

    it("HARNESS_SQLITE_DDL contains individual statements that match the bootstrapped schema", () => {
      expect(HARNESS_SQLITE_DDL.length).toBeGreaterThan(0);
      const db = new DatabaseSync(":memory:");
      for (const statement of HARNESS_SQLITE_DDL) {
        db.exec(statement);
      }
      const count = (
        db
          .prepare("SELECT count(*) as count FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
          .get() as { count: number }
      ).count;
      expect(count).toBe(allTables.length);
    });
  });

  describe("Update Lane live shapes and frames", () => {
    it("parses valid lane parameters for all update lanes", () => {
      expect(kernelMetaLaneParamsSchema.parse({})).toEqual({});
      expect(activeSessionsLaneParamsSchema.parse({ workspacePath: "/test/ws" })).toEqual({
        workspacePath: "/test/ws",
      });
      expect(activeSessionsLaneParamsSchema.parse({})).toEqual({});
      expect(recentSessionsLaneParamsSchema.parse({ limit: 25, workspacePath: "/ws", beforeMs: 5000 })).toEqual({
        limit: 25,
        workspacePath: "/ws",
        beforeMs: 5000,
      });
      expect(childSessionsLaneParamsSchema.parse({ parentSessionId: "parent-123" })).toEqual({
        parentSessionId: "parent-123",
      });
      expect(pendingAsksLaneParamsSchema.parse({ sessionId: "sess-456" })).toEqual({
        sessionId: "sess-456",
      });
      expect(pendingAsksLaneParamsSchema.parse({})).toEqual({});
    });

    it("rejects invalid lane parameters", () => {
      expect(kernelMetaLaneParamsSchema.safeParse({ unexpected: 1 }).success).toBe(false);
      expect(recentSessionsLaneParamsSchema.safeParse({ limit: 0 }).success).toBe(false);
      expect(recentSessionsLaneParamsSchema.safeParse({ limit: -10 }).success).toBe(false);
      expect(recentSessionsLaneParamsSchema.safeParse({}).success).toBe(false);
      expect(childSessionsLaneParamsSchema.safeParse({}).success).toBe(false);
      expect(childSessionsLaneParamsSchema.safeParse({ parentSessionId: "   " }).success).toBe(false);
    });

    it("parses valid shape frames (subscribe, unsubscribe, delta)", () => {
      const subscribeFrame = shapeSubscribeFrameSchema.parse({
        kind: "shape/subscribe",
        subscriptionId: "sub-1",
        lane: "recent_sessions",
        params: { limit: 50 },
        offset: 12,
      });
      expect(subscribeFrame).toEqual({
        kind: "shape/subscribe",
        subscriptionId: "sub-1",
        lane: "recent_sessions",
        params: { limit: 50 },
        offset: 12,
      });

      const unsubscribeFrame = shapeUnsubscribeFrameSchema.parse({
        kind: "shape/unsubscribe",
        subscriptionId: "sub-1",
      });
      expect(unsubscribeFrame).toEqual({
        kind: "shape/unsubscribe",
        subscriptionId: "sub-1",
      });

      const deltaFrame = shapeDeltaFrameSchema.parse({
        kind: "shape/delta",
        subscriptionId: "sub-1",
        offset: 13,
        upserts: [{ sessionId: "s1", running: true }],
        deletes: ["s0"],
        reset: false,
      });
      expect(deltaFrame).toEqual({
        kind: "shape/delta",
        subscriptionId: "sub-1",
        offset: 13,
        upserts: [{ sessionId: "s1", running: true }],
        deletes: ["s0"],
        reset: false,
      });
    });

    it("rejects shape subscribe frame with mismatched or invalid lane parameters", () => {
      expect(
        shapeSubscribeFrameSchema.safeParse({
          kind: "shape/subscribe",
          subscriptionId: "sub-1",
          lane: "recent_sessions",
          params: { limit: -1 },
        }).success,
      ).toBe(false);

      expect(
        shapeSubscribeFrameSchema.safeParse({
          kind: "shape/subscribe",
          subscriptionId: "sub-1",
          lane: "child_sessions",
          params: {},
        }).success,
      ).toBe(false);

      expect(
        shapeSubscribeFrameSchema.safeParse({
          kind: "shape/subscribe",
          subscriptionId: "sub-1",
          lane: "unknown_lane",
          params: {},
        }).success,
      ).toBe(false);

      expect(
        shapeSubscribeFrameSchema.safeParse({
          kind: "shape/subscribe",
          subscriptionId: "",
          lane: "kernel_meta",
          params: {},
        }).success,
      ).toBe(false);
    });
  });

  describe("Session Trajectory snapshots and patches", () => {
    it("round-trips session/snapshot frames with rich document trees", () => {
      const documentSnapshot: SerializedSessionDocument = {
        sessionId: "sess-node2-001",
        revision: 10,
        createdAtMs: 1700000000000,
        root: {
          id: "node-root",
          tag: "harness:session:root",
          props: {
            sessionId: "sess-node2-001",
            title: "Test Session",
            running: true,
            mode: "assistant",
          },
          children: {
            turns: [
              {
                id: "turn-1",
                tag: "harness:session:turn",
                props: {
                  prompt: "Write unit tests",
                  status: "running",
                  ordinal: 0,
                },
                children: {
                  doneWork: [],
                  queue: [],
                },
              },
            ],
          },
        },
      };

      const syncFrame: SessionSyncFrame = {
        kind: "session/snapshot",
        sessionId: "sess-node2-001",
        revision: 10,
        snapshot: documentSnapshot,
      };

      const parsed = sessionSyncFrameSchema.parse(syncFrame);
      expect(parsed).toEqual(syncFrame);
      expect(serializedSessionDocumentSchema.parse(documentSnapshot)).toEqual(documentSnapshot);
    });

    it("round-trips session/patch frames across all 5 patch operations", () => {
      const patchFrame: SessionSyncFrame = {
        kind: "session/patch",
        sessionId: "sess-node2-001",
        fromRevision: 10,
        toRevision: 11,
        patches: [
          {
            op: "set",
            nodeId: "turn-1",
            field: "status",
            value: "completed",
          },
          {
            op: "splice",
            nodeId: "turn-1",
            field: "tags",
            index: 0,
            deleteCount: 1,
            items: ["verified", "fast"],
          },
          {
            op: "del",
            nodeId: "node-root",
            field: "kvs",
            key: "scratchKey",
          },
          {
            op: "child-insert",
            nodeId: "turn-1",
            field: "doneWork",
            index: 0,
            child: {
              id: "job-exec-1",
              tag: "harness:job:shell",
              props: { command: "pnpm test", outcome: "ok" },
            },
          },
          {
            op: "child-remove",
            nodeId: "turn-1",
            field: "doneWork",
            childId: "job-exec-1",
            index: 0,
          },
        ],
      };

      const parsed = sessionSyncFrameSchema.parse(patchFrame);
      expect(parsed).toEqual(patchFrame);

      for (const patch of patchFrame.patches) {
        expect(modelPatchSchema.parse(patch)).toEqual(patch);
      }
    });

    it("parses session attach and detach lifecycle frames", () => {
      const attachWithRevision = sessionAttachFrameSchema.parse({
        kind: "session/attach",
        sessionId: "sess-1",
        sinceRevision: 5,
      });
      expect(attachWithRevision).toEqual({
        kind: "session/attach",
        sessionId: "sess-1",
        sinceRevision: 5,
      });

      const attachWithoutRevision = sessionAttachFrameSchema.parse({
        kind: "session/attach",
        sessionId: "sess-1",
      });
      expect(attachWithoutRevision).toEqual({
        kind: "session/attach",
        sessionId: "sess-1",
      });

      const detach = sessionDetachFrameSchema.parse({
        kind: "session/detach",
        sessionId: "sess-1",
      });
      expect(detach).toEqual({
        kind: "session/detach",
        sessionId: "sess-1",
      });
    });

    it("rejects invalid session sync and patch frames", () => {
      expect(
        sessionSyncFrameSchema.safeParse({
          kind: "session/unknown",
          sessionId: "sess-1",
        }).success,
      ).toBe(false);

      expect(
        sessionSyncFrameSchema.safeParse({
          kind: "session/patch",
          sessionId: "sess-1",
          fromRevision: -1,
          toRevision: 0,
          patches: [],
        }).success,
      ).toBe(false);

      expect(
        modelPatchSchema.safeParse({
          op: "unknown-op",
          nodeId: "n1",
          field: "f1",
        }).success,
      ).toBe(false);

      expect(
        modelPatchSchema.safeParse({
          op: "child-insert",
          nodeId: "n1",
          field: "doneWork",
        }).success,
      ).toBe(false);

      expect(
        modelPatchSchema.safeParse({
          op: "child-remove",
          nodeId: "n1",
          field: "doneWork",
        }).success,
      ).toBe(false);
    });
  });
});
