import { describe, expect, it } from "vitest";

import { ScopeCycle, ScopeKey, ScopeMissing, type Row } from "../cells.js";
import { createScopePlane, type ScopePlane, type ScopeView } from "../plane.js";
import type { RowPlane } from "../row-plane.js";
import { schemaSql, type TableName } from "../schema.js";

const glance = {
  sessionId: "sess-1",
  scopeId: "child",
  title: "Notes",
  lastMessageAt: 10,
  recipeScope: "",
  specName: "",
  resident: false,
  keepAlive: false,
  oneShot: false,
  model: "grok",
  status: "writing",
  midMotion: true,
  openTurn: true,
  openToolCount: 1,
  periodArmed: false,
  openCallbackCount: 0,
  asking: false,
  unfinished: "turn",
  lastPrompt: "look",
  askLine: "",
  questionLine: "",
};

function createMemoryScopePlane(): ScopePlane {
  const bags = new Map<TableName, Map<string, Row>>();
  const listeners: Array<{ table: TableName; onChange: () => void }> = [];

  function bag(table: TableName): Map<string, Row> {
    const existing = bags.get(table);
    if (existing != null) return existing;
    const created = new Map<string, Row>();
    bags.set(table, created);
    return created;
  }

  function poke(table: TableName): void {
    for (const listener of listeners) {
      if (listener.table === table) listener.onChange();
    }
  }

  const rows: RowPlane = {
    async get(table, id) {
      const row = bag(table).get(id);
      return row == null ? undefined : { ...row };
    },
    async list(table, column, equals) {
      const found: { id: string; row: Row }[] = [];
      for (const [id, row] of bag(table)) {
        if (row[column] === equals) found.push({ id, row: { ...row } });
      }
      return found;
    },
    async put(table, id, row) {
      bag(table).set(id, { ...row });
      poke(table);
    },
    async remove(table, id) {
      bag(table).delete(id);
      poke(table);
    },
    async replaceIf(table, id, column, expected, row) {
      const rowsForTable = bag(table);
      const current = rowsForTable.get(id);
      if (expected === undefined) {
        if (current != null) return false;
      } else if (current?.[column] !== expected) return false;
      rowsForTable.set(id, { ...row });
      poke(table);
      return true;
    },
    async insertIfAbsent(table, id, row) {
      const rowsForTable = bag(table);
      if (rowsForTable.has(id)) return false;
      rowsForTable.set(id, { ...row });
      poke(table);
      return true;
    },
    async removeIf(table, id, expected) {
      const rowsForTable = bag(table);
      const current = rowsForTable.get(id);
      if (current == null) return false;
      for (const [key, value] of Object.entries(expected)) {
        if (current[key] !== value) return false;
      }
      rowsForTable.delete(id);
      poke(table);
      return true;
    },
    watch(table, _match, onChange) {
      const listener = { table, onChange };
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index !== -1) listeners.splice(index, 1);
      };
    },
  };
  return createScopePlane(rows);
}

function contract(open: () => Promise<{ plane: ScopePlane; close(): Promise<void> }>): void {
  it("overlays parent config and kv, and keeps the roster local", async () => {
    const opened = await open();
    const { plane } = opened;
    await plane.ensureScope({ id: "root", parentId: null, path: null });
    await plane.ensureScope({ id: "child", parentId: "root", path: "/work" });
    expect(await plane.publishConfig("root", 0, { defaultPermissionMode: "manual", compactKeepTurns: 4 })).toBe(1);
    expect(await plane.publishConfig("child", 0, { defaultPermissionMode: "ask" })).toBe(1);
    await plane.putKv("root", "color", "blue");
    await plane.putKv("root", "size", "1");
    await plane.putKv("child", "color", "red");
    expect(await plane.insertRoster("root", "echo", "root-bot")).toBe(true);
    expect(await plane.insertRoster("child", "echo", "child-bot")).toBe(true);
    expect(await plane.insertRoster("child", "echo", "other")).toBe(false);
    expect(await plane.insertRoster("child", "echo", "child-bot")).toBe(true);

    const view = await plane.read("child");
    expect(view).toMatchObject({
      id: "child",
      parentId: "root",
      path: "/work",
      chain: ["root", "child"],
      generation: 1,
      config: { defaultPermissionMode: "ask", compactKeepTurns: 4, statusline: null },
      kv: { color: "red", size: "1" },
      roster: { echo: "child-bot" },
    });
    expect(await plane.publishConfig("child", 1, { defaultPermissionMode: null, statusline: "git" })).toBe(2);
    const cleared = await plane.read("child");
    expect(cleared?.config.defaultPermissionMode).toBe("manual");
    expect(cleared?.config.statusline).toBe("git");
    expect(cleared?.config.compactKeepTurns).toBe(4);
    await opened.close();
  });

  it("rejects a stale config generation and a stale lease", async () => {
    const opened = await open();
    const { plane } = opened;
    await plane.ensureScope({ id: "root", parentId: null, path: null });
    expect(await plane.publishConfig("root", 3, { superKey: "cmd" })).toBeNull();
    expect(await plane.publishConfig("root", 0, { superKey: "cmd" })).toBe(1);
    expect(await plane.publishConfig("root", 0, { superKey: "ctrl" })).toBeNull();
    const kept = await plane.read("root");
    expect(kept?.config.superKey).toBe("cmd");

    expect(await plane.claimGeneration("sess", "root", 0, "worker-a")).toBe(1);
    expect(await plane.claimGeneration("sess", "root", 0, "worker-b")).toBeNull();
    expect(await plane.claimGeneration("sess", "root", 1, "worker-b")).toBe(2);
    expect(await plane.releaseGeneration("sess", 2, "worker-a")).toBe(false);
    expect(await plane.releaseGeneration("sess", 2, "worker-b")).toBe(true);
    expect(await plane.claimGeneration("sess", "root", 0, "worker-a")).toBe(1);
    await opened.close();
  });

  it("lists overviews on the child only and wakes a watcher", async () => {
    const opened = await open();
    const { plane } = opened;
    await plane.ensureScope({ id: "root", parentId: null, path: null });
    await plane.ensureScope({ id: "child", parentId: "root", path: "/work" });
    let resolveArmed: () => void = () => undefined;
    const armed = new Promise<void>((resolve) => {
      resolveArmed = resolve;
    });
    let resolveSeen: (view: ScopeView | null) => void = () => undefined;
    const seen = new Promise<ScopeView | null>((resolve) => {
      resolveSeen = resolve;
    });
    const stop = plane.watch("child", (view) => {
      resolveArmed();
      if (view?.overviews[0]?.title === "Notes") resolveSeen(view);
    });
    await armed;
    await plane.writeOverview(glance);
    const view = await seen;
    stop();
    expect(view?.overviews.map((row) => row.sessionId)).toEqual(["sess-1"]);
    const root = await plane.read("root");
    expect(root?.overviews).toEqual([]);
    await opened.close();
  });

  it("refuses a missing parent, a cycle, and a NUL key", async () => {
    const opened = await open();
    const { plane } = opened;
    await plane.ensureScope({ id: "child", parentId: "gone", path: null });
    await expect(plane.read("child")).rejects.toBeInstanceOf(ScopeMissing);
    await plane.ensureScope({ id: "a", parentId: "b", path: null });
    await plane.ensureScope({ id: "b", parentId: "a", path: null });
    await expect(plane.read("a")).rejects.toBeInstanceOf(ScopeCycle);
    await expect(plane.putKv("a", "bad\0key", "x")).rejects.toBeInstanceOf(ScopeKey);
    await opened.close();
  });

  it("keeps pane, usage, and calls on this scope and overlays last-used models", async () => {
    const opened = await open();
    const { plane } = opened;
    await plane.ensureScope({ id: "root", parentId: null, path: null });
    await plane.ensureScope({ id: "child", parentId: "root", path: "/work", trusted: true, contentHash: "abc" });
    await plane.putTermContinue("child", "desk", "sess-1");
    await plane.putTermContinue("root", "desk", "other");
    await plane.stampModelUsage("child", "grok/grok-4", 9);
    await plane.putLastUsedModel("root", "grok", "grok-4");
    await plane.putLastUsedModel("child", "openai", "gpt");
    await plane.writeAgentCall({
      callId: "call-1",
      scopeId: "child",
      callerSessionId: "a",
      workerSessionId: "b",
      spec: "bot",
      oneShot: true,
      completed: false,
    });
    await plane.writeAgentCall({
      callId: "call-2",
      scopeId: "root",
      callerSessionId: "a",
      workerSessionId: "c",
      spec: "",
      oneShot: false,
      completed: true,
    });
    const view = await plane.read("child");
    expect(view).toMatchObject({
      trusted: true,
      contentHash: "abc",
      termContinue: { desk: "sess-1" },
      modelsUsage: { "grok/grok-4": 9 },
      lastUsedConnectionModel: { grok: "grok-4", openai: "gpt" },
    });
    expect(view?.agentCalls.map((call) => call.callId)).toEqual(["call-1"]);
    await plane.putTermContinue("child", "desk", null);
    await plane.putLastUsedModel("child", "openai", null);
    await plane.removeAgentCall("call-1");
    await plane.stampScope("child", { contentHash: "" });
    const cleared = await plane.read("child");
    expect(cleared?.termContinue).toEqual({});
    expect(cleared?.agentCalls).toEqual([]);
    expect(cleared?.contentHash).toBe("");
    expect(cleared?.trusted).toBe(true);
    expect(cleared?.lastUsedConnectionModel).toEqual({ grok: "grok-4" });
    const root = await plane.read("root");
    expect(root?.trusted).toBe(false);
    expect(root?.termContinue).toEqual({ desk: "other" });
    expect(root?.agentCalls.map((call) => call.callId)).toEqual(["call-2"]);
    await opened.close();
  });

  it("merges overlapping scope writes instead of dropping a stamp", async () => {
    const opened = await open();
    const { plane } = opened;
    await plane.ensureScope({ id: "root", parentId: null, path: null });
    await Promise.all([
      plane.ensureScope({ id: "s", parentId: null, path: null, trusted: true }),
      plane.ensureScope({ id: "s", parentId: null, path: null, contentHash: "abc" }),
    ]);
    await Promise.all([
      plane.ensureScope({ id: "s", parentId: "root", path: "/work" }),
      plane.stampScope("s", { contentHash: "kept" }),
    ]);
    const view = await plane.read("s");
    expect(view).toMatchObject({
      parentId: "root",
      path: "/work",
      trusted: true,
      contentHash: "kept",
    });
    await opened.close();
  });
}

describe("scope plane", () => {
  contract(async () => ({
    plane: createMemoryScopePlane(),
    async close() {
      return undefined;
    },
  }));
});

describe("schemaSql", () => {
  it("declares inheritance nulls, the roster unique key, and scope foreign keys", () => {
    const sql = schemaSql();
    expect(sql).toContain("NULL config columns inherit");
    expect(sql).toContain("UNIQUE (scope_id, name)");
    expect(sql).toContain("UNIQUE (scope_id, key)");
    expect(sql).toContain("FOREIGN KEY (scope_id) REFERENCES scopes (id)");
    expect(sql).toContain("CREATE INDEX overviews_scope ON overviews (scope_id);");
    expect(sql).toContain("CREATE INDEX term_continue_scope ON term_continue (scope_id);");
    expect(sql).toContain("UNIQUE (scope_id, connection)");
    expect(sql).toContain("content_hash text");
    expect(sql).toContain("revision bigint NOT NULL");
  });
});
