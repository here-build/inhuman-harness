import { pairId, ScopeKey, tables, type Row, type RowPlane } from "@inhuman.tools/scope-plane";
import { describe, expect, it } from "vitest";

import { createElectricRowPlane } from "../index.js";
import { createSqlDouble } from "./sql-double.js";

function makeProjectRow(overrides: Partial<Row> = {}): Row {
  return {
    kernelId: "tenant-a",
    title: "Cloud Project",
    kind: "virtual",
    defaultPermissionMode: "manual",
    authorizationJson: "{}",
    kvsJson: "{}",
    lastUsedModelJson: "{}",
    enabledPluginsJson: '["todos"]',
    pluginConfigsJson: "{}",
    botsRosterJson: "{}",
    trusted: false,
    revision: 0,
    updatedAtMs: 1000,
    ...overrides,
  };
}

function makeSessionRow(overrides: Partial<Row> = {}): Row {
  return {
    kernelId: "tenant-a",
    projectId: "proj-1",
    title: "Session 1",
    workspacePath: "",
    mode: "agentic",
    permissionMode: "manual",
    running: false,
    depth: 0,
    revision: 0,
    createdAtMs: 1000,
    lastActiveAtMs: 1000,
    ...overrides,
  };
}

function open(): { rows: RowPlane; texts: string[] } {
  const sql = createSqlDouble();
  return { rows: createElectricRowPlane({ sql, shapes: sql.shapes }), texts: sql.texts };
}

describe("electric SQL RowPlane over canonical 11-table contract", () => {
  it("performs get, list, put, replaceIf, replaceIfMatch, removeIf, and SQL statement shaping", async () => {
    const { rows, texts } = open();

    const p0 = makeProjectRow();
    expect(await rows.insertIfAbsent("projects", "proj-1", p0)).toBe(true);
    expect(await rows.insertIfAbsent("projects", "proj-1", p0)).toBe(false);
    expect(await rows.get("projects", "proj-1")).toEqual(p0);

    const p1 = makeProjectRow({ title: "Updated", revision: 1, trusted: true, updatedAtMs: 2000 });
    expect(await rows.replaceIf("projects", "proj-1", "revision", 0, p1)).toBe(true);
    expect(await rows.replaceIf("projects", "proj-1", "revision", 0, p0)).toBe(false);

    const p2 = makeProjectRow({ title: "CAS Matched", revision: 2, updatedAtMs: 3000 });
    expect(await rows.replaceIfMatch("projects", "proj-1", { kernelId: "tenant-a", revision: 1 }, p2)).toBe(true);
    expect(await rows.replaceIfMatch("projects", "proj-1", { revision: 1 }, p2)).toBe(false);

    const s0 = makeSessionRow({ running: true });
    await rows.put("sessions", "sess-1", s0);
    expect((await rows.list("sessions", "projectId", "proj-1")).map((entry) => entry.id)).toEqual(["sess-1"]);

    expect(await rows.removeIf("projects", "proj-1", { revision: 99 })).toBe(false);
    expect(await rows.removeIf("projects", "proj-1", { revision: 2 })).toBe(true);
    expect(await rows.get("projects", "proj-1")).toBeUndefined();

    expect(texts.some((text) => text.includes("ON CONFLICT (project_id) DO NOTHING"))).toBe(true);
    expect(texts.some((text) => text.startsWith("UPDATE projects SET") && text.includes("AND revision ="))).toBe(true);
  });

  it("wakes watch subscribers on commits and enforces pairId/required column checks", async () => {
    const { rows } = open();

    let changes = 0;
    const stop = rows.watch("scm_resources", { column: "scopeId", equals: "proj-1" }, () => {
      changes += 1;
    });
    const scmId = pairId("project", "proj-1:bot/research");
    await rows.put("scm_resources", scmId, {
      kernelId: "tenant-a",
      scope: "project",
      scopeId: "proj-1",
      kind: "bot",
      name: "research.scm",
      source: "(bot)",
      sha256: "deadbeef",
      updatedAtMs: 5000,
    });
    stop();
    expect(changes).toBe(1);
    expect((await rows.list("scm_resources", "scopeId", "proj-1"))[0]?.row.name).toBe("research.scm");

    expect(() => pairId("kernel", "bad\0id")).toThrow(ScopeKey);
    await expect(rows.put("projects", "bad-proj", { title: "Missing required columns" })).rejects.toThrow(
      /missing projects\./,
    );
    expect(Object.keys(tables)).toHaveLength(11);
  });

  it("refuses atomic snapshot when no SQL transaction port is supplied", async () => {
    const { rows } = open();
    expect(rows.snapshot).toBeUndefined();
  });
});
