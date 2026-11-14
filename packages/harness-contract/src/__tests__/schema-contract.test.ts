import { DatabaseSync } from "node:sqlite";

import { getTableConfig } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";

import {
  activeSessionsLaneParamsSchema,
  bootstrapHarnessPostgresSql,
  childSessionsLaneParamsSchema,
  HARNESS_POSTGRES_DDL,
  kernelMetaLaneParamsSchema,
  modelPatchSchema,
  pendingAsksLaneParamsSchema,
  planeWireFrameSchema,
  presenceFrameSchema,
  recentSessionsLaneParamsSchema,
  rowPairId,
  schemaSql,
  scopeNodesLaneParamsSchema,
  serializedSessionDocumentSchema,
  sessionAttachFrameSchema,
  sessionDetachFrameSchema,
  sessionNodesLaneParamsSchema,
  sessionSyncFrameSchema,
  shapeDeltaFrameSchema,
  shapeSubscribeFrameSchema,
  shapeUnsubscribeFrameSchema,
  splitRowPairId,
  streamDeltaFrameSchema,
  tables,
  type SerializedSessionDocument,
  type SessionSyncFrame,
} from "../index.js";
import {
  bootstrapHarnessSqliteSql,
  HARNESS_SQLITE_DDL,
  HARNESS_TABLE_NAMES,
  kernelStateTable,
  pendingAsksTable,
  pluginStateLogsTable,
  projectsTable,
  scmResourcesTable,
  scopeNodesTable,
  sessionBlobsTable,
  sessionEffectsTable,
  sessionNodesTable,
  sessionsTable,
  sessionTurnsTable,
} from "../schema/index.js";

describe("schema and wire contract", () => {
  describe("Drizzle table metadata vs SQLite & Postgres DDL", () => {
    const allTables = [
      kernelStateTable,
      projectsTable,
      scopeNodesTable,
      sessionsTable,
      pendingAsksTable,
      sessionTurnsTable,
      sessionNodesTable,
      sessionEffectsTable,
      sessionBlobsTable,
      scmResourcesTable,
      pluginStateLogsTable,
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
        // Every table has a single-column string PK for ElectricSQL / LiveShape compatibility
        expect(singlePkCols, `Single-column PK for ${config.name}`).toHaveLength(1);
        expect(actualPkCols, `Primary key for ${config.name}`).toEqual(singlePkCols);

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

    it("HARNESS_SQLITE_DDL and HARNESS_POSTGRES_DDL cover the exact same canonical table set", () => {
      expect(HARNESS_SQLITE_DDL.length).toBeGreaterThan(0);
      expect(HARNESS_POSTGRES_DDL.length).toBeGreaterThan(0);

      const expectedNames = allTables.map((t) => getTableConfig(t).name).sort();
      const pgCreatedTables = [...bootstrapHarnessPostgresSql.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_]+)/g)]
        .map((m) => m[1]!)
        .sort();
      expect(pgCreatedTables).toEqual(expectedNames);
      expect(schemaSql()).toBe(bootstrapHarnessPostgresSql);
      expect([...HARNESS_TABLE_NAMES].sort()).toEqual(expectedNames);
      for (const table of allTables) {
        const cfg = getTableConfig(table);
        const def = tables[cfg.name as keyof typeof tables];
        expect(def).toBeDefined();
        expect(def.sql).toBe(cfg.name);
        const pk = cfg.columns.find((col) => col.primary);
        expect(pk).toBeDefined();
        expect(def.keySql).toBe(pk!.name);
        expect(def.columns.map((col) => col.sql)).toEqual(
          cfg.columns.filter((col) => !col.primary).map((col) => col.name),
        );
      }
      expect(bootstrapHarnessPostgresSql).toContain("ALTER TABLE kernel_state REPLICA IDENTITY FULL;");
      expect(bootstrapHarnessPostgresSql).toContain("ALTER TABLE projects REPLICA IDENTITY FULL;");
      expect(bootstrapHarnessPostgresSql).toContain("ALTER TABLE session_nodes REPLICA IDENTITY FULL;");
      expect(bootstrapHarnessPostgresSql).toContain("ALTER TABLE scope_nodes REPLICA IDENTITY FULL;");
      expect(bootstrapHarnessPostgresSql).toContain("ALTER TABLE scm_resources REPLICA IDENTITY FULL;");
      expect(bootstrapHarnessPostgresSql).toContain("ALTER TABLE plugin_state_logs REPLICA IDENTITY FULL;");
    });

    it("encodes and decodes NUL-free composite keys via rowPairId / splitRowPairId", () => {
      const id = rowPairId("sess-1", "node-abc");
      expect(id.includes("\0")).toBe(false);
      expect(splitRowPairId(id)).toEqual(["sess-1", "node-abc"]);
      expect(() => rowPairId("bad\0id", "node")).toThrow(/NUL/);
    });
  });

  describe("Update Lane live shapes and unified wire frames", () => {
    it("parses valid lane parameters for all update lanes", () => {
      expect(kernelMetaLaneParamsSchema.parse({})).toEqual({});
      expect(kernelMetaLaneParamsSchema.parse({ kernelId: "tenant-a" })).toEqual({ kernelId: "tenant-a" });
      expect(scopeNodesLaneParamsSchema.parse({ kernelId: "tenant-a", scopeId: "kernel" })).toEqual({
        kernelId: "tenant-a",
        scopeId: "kernel",
      });
      expect(sessionNodesLaneParamsSchema.parse({ kernelId: "tenant-a", sessionId: "sess-1" })).toEqual({
        kernelId: "tenant-a",
        sessionId: "sess-1",
      });
      expect(activeSessionsLaneParamsSchema.parse({ kernelId: "tenant-a", projectId: "proj-1", workspacePath: "/test/ws" })).toEqual({
        kernelId: "tenant-a",
        projectId: "proj-1",
        workspacePath: "/test/ws",
      });
      expect(activeSessionsLaneParamsSchema.parse({})).toEqual({});
      expect(
        recentSessionsLaneParamsSchema.parse({
          kernelId: "tenant-a",
          projectId: "proj-1",
          limit: 25,
          workspacePath: "/ws",
          beforeMs: 5000,
        }),
      ).toEqual({
        kernelId: "tenant-a",
        projectId: "proj-1",
        limit: 25,
        workspacePath: "/ws",
        beforeMs: 5000,
      });
      expect(childSessionsLaneParamsSchema.parse({ kernelId: "tenant-a", parentSessionId: "parent-123" })).toEqual({
        kernelId: "tenant-a",
        parentSessionId: "parent-123",
      });
      expect(pendingAsksLaneParamsSchema.parse({ kernelId: "tenant-a", sessionId: "sess-456" })).toEqual({
        kernelId: "tenant-a",
        sessionId: "sess-456",
      });
      expect(pendingAsksLaneParamsSchema.parse({})).toEqual({});
    });

    it("rejects invalid lane parameters", () => {
      expect(kernelMetaLaneParamsSchema.safeParse({ unexpected: 1 }).success).toBe(false);
      expect(scopeNodesLaneParamsSchema.safeParse({}).success).toBe(false);
      expect(sessionNodesLaneParamsSchema.safeParse({ sessionId: "  " }).success).toBe(false);
      expect(recentSessionsLaneParamsSchema.safeParse({ limit: 0 }).success).toBe(false);
      expect(recentSessionsLaneParamsSchema.safeParse({ limit: -10 }).success).toBe(false);
      expect(recentSessionsLaneParamsSchema.safeParse({}).success).toBe(false);
      expect(childSessionsLaneParamsSchema.safeParse({}).success).toBe(false);
      expect(childSessionsLaneParamsSchema.safeParse({ parentSessionId: "   " }).success).toBe(false);
    });

    it("parses shape, presence, stream/delta, and keepalive frames", () => {
      const subscribeFrame = shapeSubscribeFrameSchema.parse({
        kind: "shape/subscribe",
        subscriptionId: "sub-1",
        lane: "session_nodes",
        params: { sessionId: "sess-1" },
        offset: 12,
      });
      expect(subscribeFrame).toEqual({
        kind: "shape/subscribe",
        subscriptionId: "sub-1",
        lane: "session_nodes",
        params: { sessionId: "sess-1" },
        offset: 12,
      });

      expect(
        shapeUnsubscribeFrameSchema.parse({
          kind: "shape/unsubscribe",
          subscriptionId: "sub-1",
        }),
      ).toEqual({
        kind: "shape/unsubscribe",
        subscriptionId: "sub-1",
      });

      expect(
        shapeDeltaFrameSchema.parse({
          kind: "shape/delta",
          subscriptionId: "sub-1",
          offset: 13,
          upserts: [{ id: '["s1","n1"]', nodeId: "n1" }],
          deletes: ['["s1","n0"]'],
          reset: false,
        }),
      ).toMatchObject({ kind: "shape/delta", subscriptionId: "sub-1" });

      expect(
        presenceFrameSchema.parse({
          kind: "presence/update",
          room: "session:s1",
          entries: [[1, { occupied: true }, 2]],
        }),
      ).toEqual({
        kind: "presence/update",
        room: "session:s1",
        entries: [[1, { occupied: true }, 2]],
      });

      expect(
        streamDeltaFrameSchema.parse({
          kind: "stream/delta",
          sessionId: "s1",
          channel: "assistant",
          targetId: "step-1",
          text: "hello",
        }),
      ).toEqual({
        kind: "stream/delta",
        sessionId: "s1",
        channel: "assistant",
        targetId: "step-1",
        text: "hello",
      });

      expect(planeWireFrameSchema.parse({ kind: "ping", ts: 123 })).toEqual({ kind: "ping", ts: 123 });
      expect(planeWireFrameSchema.parse({ kind: "pong", ts: 123 })).toEqual({ kind: "pong", ts: 123 });
    });
  });

  describe("Session Trajectory snapshots and patches", () => {
    it("round-trips session/snapshot and session/patch frames", () => {
      const documentSnapshot: SerializedSessionDocument = {
        sessionId: "sess-node2-001",
        revision: 10,
        createdAtMs: 1700000000000,
        root: {
          id: "node-root",
          tag: "harness:session:root",
          props: { sessionId: "sess-node2-001", title: "Test Session" },
        },
      };

      const syncFrame: SessionSyncFrame = {
        kind: "session/snapshot",
        sessionId: "sess-node2-001",
        revision: 10,
        snapshot: documentSnapshot,
      };
      expect(sessionSyncFrameSchema.parse(syncFrame)).toEqual(syncFrame);
      expect(serializedSessionDocumentSchema.parse(documentSnapshot)).toEqual(documentSnapshot);

      const patch = modelPatchSchema.parse({
        op: "set",
        nodeId: "turn-1",
        field: "status",
        value: "completed",
      });
      expect(patch.op).toBe("set");

      expect(sessionAttachFrameSchema.parse({ kind: "session/attach", sessionId: "s1" })).toEqual({
        kind: "session/attach",
        sessionId: "s1",
      });
      expect(sessionDetachFrameSchema.parse({ kind: "session/detach", sessionId: "s1" })).toEqual({
        kind: "session/detach",
        sessionId: "s1",
      });
    });
  });
});
