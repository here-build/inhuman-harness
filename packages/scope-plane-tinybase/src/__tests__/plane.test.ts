import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createScopePlane, ScopeCycle, ScopeKey, ScopeMissing, type ScopeView } from "@inhuman.tools/scope-plane";
import { createStore } from "tinybase";
import { createFilePersister } from "tinybase/persisters/persister-file";
import { describe, expect, it } from "vitest";

import { createTinybaseRowPlane, createTinybaseScopePlane, type OpenScopePlane } from "../index.js";

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

function contract(open: () => Promise<OpenScopePlane>): void {
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

    const view = await plane.read("child");
    expect(view).toMatchObject({
      path: "/work",
      chain: ["root", "child"],
      config: { defaultPermissionMode: "ask", compactKeepTurns: 4 },
      kv: { color: "red", size: "1" },
      roster: { echo: "child-bot" },
    });
    await opened.close();
  });

  it("rejects a stale lease and wakes on a glance", async () => {
    const opened = await open();
    const { plane } = opened;
    await plane.ensureScope({ id: "root", parentId: null, path: null });
    expect(await plane.claimGeneration("sess", "root", 0, "worker-a")).toBe(1);
    expect(await plane.claimGeneration("sess", "root", 0, "worker-b")).toBeNull();
    expect(await plane.releaseGeneration("sess", 1, "worker-a")).toBe(true);

    let resolveArmed: () => void = () => undefined;
    const armed = new Promise<void>((resolve) => {
      resolveArmed = resolve;
    });
    let resolveSeen: (view: ScopeView | null) => void = () => undefined;
    const seen = new Promise<ScopeView | null>((resolve) => {
      resolveSeen = resolve;
    });
    const stop = plane.watch("root", (view) => {
      resolveArmed();
      if (view?.overviews[0]?.title === "Notes") resolveSeen(view);
    });
    await armed;
    await plane.writeOverview({ ...glance, scopeId: "root" });
    const view = await seen;
    stop();
    expect(view?.overviews.map((row) => row.sessionId)).toEqual(["sess-1"]);
    await opened.close();
  });

  it("refuses a cycle and a NUL key", async () => {
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
    await plane.stampModelUsage("root", "grok/grok-4", 3);
    await plane.putLastUsedModel("root", "grok", "grok-4");
    await plane.putLastUsedModel("child", "openai", "gpt");
    await plane.writeAgentCall({
      callId: "call-1",
      scopeId: "child",
      callerSessionId: "a",
      workerSessionId: "b",
      spec: "bot",
      oneShot: false,
      completed: false,
    });
    const view = await plane.read("child");
    expect(view).toMatchObject({
      trusted: true,
      contentHash: "abc",
      termContinue: { desk: "sess-1" },
      modelsUsage: {},
      lastUsedConnectionModel: { grok: "grok-4", openai: "gpt" },
    });
    expect(view?.agentCalls.map((call) => call.callId)).toEqual(["call-1"]);
    const root = await plane.read("root");
    expect(root?.modelsUsage).toEqual({ "grok/grok-4": 3 });
    expect(root?.termContinue).toEqual({});
    await opened.close();
  });
}

describe("tinybase", () => {
  contract(() => createTinybaseScopePlane());

  it("reloads the scope from the json file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scope-plane-"));
    const file = join(dir, "scope.json");
    const first = await createTinybaseScopePlane({ file });
    await first.plane.ensureScope({ id: "root", parentId: null, path: null });
    await first.plane.putKv("root", "color", "blue");
    expect(await first.flush()).toEqual({ status: "file-saved", file });
    const beforeClose = await createTinybaseScopePlane({ file });
    expect((await beforeClose.plane.read("root"))?.kv.color).toBe("blue");
    await beforeClose.close();
    await first.close();
    const second = await createTinybaseScopePlane({ file });
    const restored = await second.plane.read("root");
    expect(restored?.kv.color).toBe("blue");
    await second.close();
  });

  it("retains generations across release and fences overview and call mutations", async () => {
    const opened = await createTinybaseScopePlane();
    const { plane } = opened;
    await plane.ensureScope({ id: "child", parentId: null, path: null });
    const old = { sessionId: "sess-1", scopeId: "child", generation: 1, holder: "same-worker" };
    expect(await plane.claimGeneration(old.sessionId, old.scopeId, 0, old.holder)).toBe(1);
    expect(await plane.writeOverviewOwned(old, glance)).toBe(true);
    expect(await plane.releaseGeneration(old.sessionId, 1, old.holder)).toBe(true);
    expect(await plane.claimGeneration(old.sessionId, old.scopeId, 0, old.holder)).toBe(2);
    expect(await plane.releaseGeneration(old.sessionId, 1, old.holder)).toBe(false);
    expect(await plane.writeOverviewOwned(old, { ...glance, title: "stale" })).toBe(false);
    const current = { ...old, generation: 2 };
    expect(await plane.takeoverGeneration({ ...current, holder: "wrong" }, "next")).toBeNull();
    expect(await plane.takeoverGeneration(current, "next")).toBe(3);
    const next = { ...current, generation: 3, holder: "next" };
    const call = {
      callId: "call",
      scopeId: "child",
      callerSessionId: "sess-1",
      workerSessionId: "worker",
      spec: "",
      oneShot: true,
      completed: false,
    };
    expect(await plane.writeAgentCallOwned(current, call)).toBe(false);
    expect(await plane.writeAgentCallOwned(next, call)).toBe(true);
    const other = { sessionId: "other", scopeId: "child", generation: 1, holder: "other-worker" };
    await plane.claimGeneration(other.sessionId, other.scopeId, 0, other.holder);
    expect(await plane.writeAgentCallOwned(other, { ...call, callerSessionId: "other" })).toBe(false);
    expect(await plane.removeAgentCallOwned(other, call.callId)).toBe(false);
    expect(await plane.removeAgentCallOwned(current, call.callId)).toBe(false);
    expect(await plane.removeAgentCallOwned(next, call.callId)).toBe(true);
    expect((await plane.read("child"))?.overviews[0]?.title).toBe("Notes");
    expect(await opened.flush()).toEqual({ status: "memory" });
    await opened.close();
  });

  it("captures every table before the snapshot callback starts", async () => {
    const rows = createTinybaseRowPlane(createStore());
    const plane = createScopePlane(rows);
    await plane.ensureScope({ id: "root", parentId: null, path: null });
    await plane.ensureScope({ id: "child", parentId: "root", path: null });
    await plane.publishConfig("root", 0, { compactKeepTurns: 4 });
    await plane.putKv("root", "color", "blue");
    const capturing = createScopePlane({
      ...rows,
      async snapshot(read) {
        if (!rows.snapshot) throw new Error("missing snapshot");
        return rows.snapshot(async (captured) => {
          await plane.publishConfig("root", 1, { compactKeepTurns: 8 });
          await plane.putKv("root", "color", "red");
          return read(captured);
        });
      },
    });
    const snapshot = await capturing.readSnapshot("child");
    expect(snapshot).toMatchObject({ consistency: "snapshot", config: { compactKeepTurns: 4 }, kv: { color: "blue" } });
    const current = await plane.readSnapshot("child");
    expect(current).toMatchObject({ config: { compactKeepTurns: 8 }, kv: { color: "red" } });
    expect(current?.revision).not.toBe(snapshot?.revision);
  });

  it("reports a failed file flush instead of acknowledging it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scope-plane-failed-"));
    const opened = await createTinybaseScopePlane({ file: join(dir, "missing", "scope.json") });
    await opened.plane.ensureScope({ id: "root", parentId: null, path: null });
    expect(await opened.flush()).toMatchObject({ status: "failed" });
    await expect(opened.close()).rejects.toThrow();
  });

  it("migrates the previous NUL-separated file keys before writes or removal", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scope-plane-legacy-"));
    const file = join(dir, "scope.json");
    const legacy = createStore();
    legacy.setRow("scopes", "root", { parentId: "", path: "", revision: 1 });
    legacy.setRow("kv", "root\0color", { scopeId: "root", key: "color", value: "blue" });
    const persister = createFilePersister(legacy, file);
    await persister.save();
    await persister.destroy();
    const opened = await createTinybaseScopePlane({ file });
    await opened.plane.putKv("root", "color", "red");
    const changed = await opened.plane.read("root");
    expect(changed?.kv).toEqual({ color: "red" });
    await opened.plane.putKv("root", "color", null);
    const removed = await opened.plane.read("root");
    expect(removed?.kv).toEqual({});
    await opened.close();
  });
});
