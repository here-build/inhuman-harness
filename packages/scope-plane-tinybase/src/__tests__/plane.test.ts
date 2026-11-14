import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HARNESS_TABLE_NAMES, pairId, ScopeKey, type Row } from "@inhuman.tools/scope-plane";
import { createStore } from "tinybase";
import { describe, expect, it } from "vitest";

import { createTinybaseRowPlane, openTinybaseRowPlane, type OpenTinybaseRowPlane } from "../index.js";

function makeProjectRow(overrides: Partial<Row> = {}): Row {
  return {
    kernelId: "tenant-a",
    title: "Local Workspace",
    kind: "local",
    defaultPermissionMode: "manual",
    authorizationJson: "{}",
    kvsJson: "{}",
    lastUsedModelJson: "{}",
    enabledPluginsJson: "[]",
    pluginConfigsJson: "{}",
    botsRosterJson: "{}",
    trusted: false,
    revision: 0,
    updatedAtMs: 1000,
    ...overrides,
  };
}

function contract(open: () => Promise<OpenTinybaseRowPlane>): void {
  it("supports get/list/put/remove and CAS operations across canonical tables", async () => {
    const opened = await open();
    const { rows } = opened;

    const p0 = makeProjectRow();
    expect(await rows.insertIfAbsent("projects", "proj-1", p0)).toBe(true);
    expect(await rows.insertIfAbsent("projects", "proj-1", p0)).toBe(false);
    expect(await rows.get("projects", "proj-1")).toEqual(p0);

    const p1 = makeProjectRow({ title: "Updated", trusted: true, revision: 1, updatedAtMs: 2000 });
    expect(await rows.replaceIf("projects", "proj-1", "revision", 0, p1)).toBe(true);
    expect(await rows.replaceIf("projects", "proj-1", "revision", 0, p0)).toBe(false);
    expect(await rows.replaceIfMatch("projects", "proj-1", { kernelId: "tenant-a", revision: 1 }, p0)).toBe(true);

    const logId = pairId("global", "todos:tenant-a");
    await rows.put("plugin_state_logs", logId, {
      kernelId: "tenant-a",
      plugin: "todos",
      scope: "global",
      scopeId: "tenant-a",
      namespace: "default",
      logJson: '[{"id":1}]',
      updatedAtMs: 2500,
    });
    expect((await rows.list("plugin_state_logs", "plugin", "todos")).map((entry) => entry.id)).toEqual([logId]);

    expect(await rows.removeIf("projects", "proj-1", { revision: 99 })).toBe(false);
    expect(await rows.removeIf("projects", "proj-1", { revision: 0 })).toBe(true);
    expect(await rows.get("projects", "proj-1")).toBeUndefined();
    await opened.close();
  });

  it("wakes watchers on table changes and enforces NUL-free pairId", async () => {
    const opened = await open();
    const { rows } = opened;

    let notified = false;
    const stop = rows.watch("scm_resources", { column: "kernelId", equals: "tenant-a" }, () => {
      notified = true;
    });
    const scmId = pairId("kernel", "tenant-a:policy/default");
    await rows.put("scm_resources", scmId, {
      kernelId: "tenant-a",
      scope: "kernel",
      scopeId: "tenant-a",
      kind: "policy",
      name: "default.scm",
      source: "(allow)",
      sha256: "hash",
      updatedAtMs: 3000,
    });
    stop();
    expect(notified).toBe(true);
    expect(() => pairId("kernel", "bad\0key")).toThrow(ScopeKey);
    expect(HARNESS_TABLE_NAMES).toContain("plugin_state_logs");
    await opened.close();
  });
}

describe("tinybase RowPlane", () => {
  contract(() => openTinybaseRowPlane());

  it("reloads canonical tables from the JSON file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scope-plane-"));
    const file = join(dir, "scope.json");
    const first = await openTinybaseRowPlane({ file });
    await first.rows.put("projects", "proj-1", makeProjectRow({ title: "Saved" }));
    expect(await first.flush()).toEqual({ status: "file-saved", file });

    const beforeClose = await openTinybaseRowPlane({ file });
    expect((await beforeClose.rows.get("projects", "proj-1"))?.title).toBe("Saved");
    await beforeClose.close();
    await first.close();

    const second = await openTinybaseRowPlane({ file });
    expect((await second.rows.get("projects", "proj-1"))?.title).toBe("Saved");
    await second.close();
  });

  it("captures every table in snapshot before concurrent writes arrive", async () => {
    const rows = createTinybaseRowPlane(createStore());
    await rows.put("projects", "proj-1", makeProjectRow({ title: "Initial", revision: 1 }));

    const observed = await rows.snapshot?.(async (captured) => {
      await rows.put("projects", "proj-1", makeProjectRow({ title: "Mutated", revision: 2 }));
      return captured.get("projects", "proj-1");
    });

    expect(observed?.title).toBe("Initial");
    expect((await rows.get("projects", "proj-1"))?.title).toBe("Mutated");
  });

  it("reports a failed file flush instead of acknowledging it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scope-plane-failed-"));
    const opened = await openTinybaseRowPlane({ file: join(dir, "missing", "scope.json") });
    await opened.rows.put("projects", "proj-1", makeProjectRow());
    expect(await opened.flush()).toMatchObject({ status: "failed" });
    await expect(opened.close()).rejects.toThrow();
  });
});
