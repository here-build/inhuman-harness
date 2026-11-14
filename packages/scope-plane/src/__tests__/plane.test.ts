import { describe, expect, it } from "vitest";

import {
  HARNESS_TABLE_NAMES,
  ScopeKey,
  coerceCell,
  columnOf,
  pairId,
  schemaSql,
  tables,
  type Row,
  type RowMatch,
  type RowPlane,
  type TableName,
} from "../index.js";

function createMemoryRowPlane(): RowPlane {
  const stores = new Map<TableName, Map<string, Row>>();
  const watchers = new Map<TableName, Set<() => void>>();

  const tableMap = (table: TableName): Map<string, Row> => {
    let m = stores.get(table);
    if (!m) {
      m = new Map();
      stores.set(table, m);
    }
    return m;
  };

  const notify = (table: TableName): void => {
    for (const cb of watchers.get(table) ?? []) {
      cb();
    }
  };

  const makePlane = (snapshotData?: Map<TableName, Map<string, Row>>): RowPlane => ({
    async get(table, id) {
      const m = (snapshotData ?? stores).get(table);
      const row = m?.get(id);
      return row ? { ...row } : undefined;
    },
    async list(table, column, equals) {
      const m = (snapshotData ?? stores).get(table);
      if (!m) return [];
      const out: { id: string; row: Row }[] = [];
      for (const [id, row] of m) {
        if (row[column] === equals) out.push({ id, row: { ...row } });
      }
      return out;
    },
    async put(table, id, row) {
      tableMap(table).set(id, { ...row });
      notify(table);
    },
    async remove(table, id) {
      if (tableMap(table).delete(id)) {
        notify(table);
      }
    },
    async replaceIf(table, id, column, expectVal, row) {
      const m = tableMap(table);
      const existing = m.get(id);
      if (expectVal === undefined) {
        if (existing !== undefined) return false;
        m.set(id, { ...row });
        notify(table);
        return true;
      }
      if (!existing || existing[column] !== expectVal) return false;
      m.set(id, { ...row });
      notify(table);
      return true;
    },
    async replaceIfMatch(table, id, expected, row) {
      const m = tableMap(table);
      const existing = m.get(id);
      if (!existing) return false;
      for (const [k, v] of Object.entries(expected)) {
        if (existing[k] !== v) return false;
      }
      m.set(id, { ...row });
      notify(table);
      return true;
    },
    async insertIfAbsent(table, id, row) {
      const m = tableMap(table);
      if (m.has(id)) return false;
      m.set(id, { ...row });
      notify(table);
      return true;
    },
    async removeIf(table, id, expected) {
      const m = tableMap(table);
      const existing = m.get(id);
      if (!existing) return false;
      for (const [k, v] of Object.entries(expected)) {
        if (existing[k] !== v) return false;
      }
      m.delete(id);
      notify(table);
      return true;
    },
    watch(table, _match: RowMatch, onChange) {
      let set = watchers.get(table);
      if (!set) {
        set = new Set();
        watchers.set(table, set);
      }
      set.add(onChange);
      return () => {
        set.delete(onChange);
      };
    },
    async snapshot(read) {
      const copy = new Map<TableName, Map<string, Row>>();
      for (const [t, m] of stores) {
        const inner = new Map<string, Row>();
        for (const [id, r] of m) inner.set(id, { ...r });
        copy.set(t, inner);
      }
      return read(makePlane(copy));
    },
  });

  return makePlane();
}

describe("Canonical 11-table RowPlane & contract re-exports", () => {
  it("exposes all 11 canonical Agent DB tables, columnOf, and Postgres schemaSql()", () => {
    expect(HARNESS_TABLE_NAMES).toEqual([
      "kernel_state",
      "projects",
      "scope_nodes",
      "sessions",
      "pending_asks",
      "session_turns",
      "session_nodes",
      "session_effects",
      "session_blobs",
      "scm_resources",
      "plugin_state_logs",
    ]);

    for (const table of HARNESS_TABLE_NAMES) {
      expect(tables[table].sql).toBe(table);
      expect(columnOf(table, "kernelId")).toEqual({
        name: "kernelId",
        sql: "kernel_id",
        kind: "string",
        required: true,
      });
    }

    const sql = schemaSql();
    for (const table of HARNESS_TABLE_NAMES) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    expect(sql).toContain("ALTER TABLE projects REPLICA IDENTITY FULL;");
    expect(sql).toContain("ALTER TABLE scm_resources REPLICA IDENTITY FULL;");
    expect(sql).toContain("ALTER TABLE plugin_state_logs REPLICA IDENTITY FULL;");
  });

  it("validates composite pairId keys and cell coercions", () => {
    expect(pairId("kernel", "node-1")).toBe('["kernel","node-1"]');
    expect(() => pairId("kernel", "bad\0key")).toThrow(ScopeKey);
    expect(() => pairId("bad\0scope", "key")).toThrow(ScopeKey);

    expect(coerceCell("string", "hello")).toBe("hello");
    expect(coerceCell("string", 123)).toBeUndefined();
    expect(coerceCell("boolean", true)).toBe(true);
    expect(coerceCell("boolean", 1)).toBeUndefined();
    expect(coerceCell("number", 42)).toBe(42);
    expect(coerceCell("number", "1700000000000")).toBe(1_700_000_000_000);
    expect(coerceCell("number", "not-a-num")).toBeUndefined();
  });

  it("supports get/list/put/remove, CAS guards, watch, and snapshots across canonical tables", async () => {
    const plane = createMemoryRowPlane();
    let projectChanges = 0;
    const unwatch = plane.watch("projects", { column: "kernelId", equals: "tenant-a" }, () => {
      projectChanges += 1;
    });

    const projectRow: Row = {
      kernelId: "tenant-a",
      title: "App",
      kind: "virtual",
      defaultPermissionMode: "manual",
      authorizationJson: "{}",
      kvsJson: "{}",
      lastUsedModelJson: "{}",
      enabledPluginsJson: '["todos"]',
      pluginConfigsJson: "{}",
      botsRosterJson: "{}",
      trusted: false,
      revision: 1,
      updatedAtMs: 1000,
    };

    expect(await plane.insertIfAbsent("projects", "proj-1", projectRow)).toBe(true);
    expect(await plane.insertIfAbsent("projects", "proj-1", projectRow)).toBe(false);
    expect(await plane.get("projects", "proj-1")).toEqual(projectRow);
    expect(projectChanges).toBe(1);

    expect(
      await plane.replaceIf("projects", "proj-1", "revision", 1, {
        ...projectRow,
        title: "App v2",
        revision: 2,
        updatedAtMs: 2000,
      }),
    ).toBe(true);
    expect(await plane.replaceIf("projects", "proj-1", "revision", 1, projectRow)).toBe(false);

    expect(
      await plane.replaceIfMatch(
        "projects",
        "proj-1",
        { kernelId: "tenant-a", revision: 2 },
        { ...projectRow, title: "App v3", trusted: true, revision: 3, updatedAtMs: 3000 },
      ),
    ).toBe(true);

    const scmId = pairId("project", "proj-1:policy/default");
    await plane.put("scm_resources", scmId, {
      kernelId: "tenant-a",
      scope: "project",
      scopeId: "proj-1",
      kind: "policy",
      name: "default.scm",
      source: "(policy)",
      sha256: "abc123",
      updatedAtMs: 3000,
    });

    const snapTitle = await plane.snapshot?.(async (reader) => {
      await plane.put("projects", "proj-1", { ...projectRow, title: "Outside Snapshot", revision: 4 });
      return (await reader.get("projects", "proj-1"))?.title;
    });
    expect(snapTitle).toBe("App v3");
    expect((await plane.get("projects", "proj-1"))?.title).toBe("Outside Snapshot");

    expect((await plane.list("scm_resources", "scopeId", "proj-1")).map((r) => r.id)).toEqual([scmId]);
    expect(await plane.removeIf("projects", "proj-1", { revision: 99 })).toBe(false);
    expect(await plane.removeIf("projects", "proj-1", { revision: 4 })).toBe(true);
    expect(await plane.get("projects", "proj-1")).toBeUndefined();

    unwatch();
  });
});
