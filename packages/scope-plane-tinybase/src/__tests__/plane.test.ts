import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ScopeCycle, ScopeKey, ScopeMissing, type ScopeView } from "@inhuman.tools/scope-plane";
import { describe, expect, it } from "vitest";

import { createTinybaseScopePlane, type OpenScopePlane } from "../index.js";

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
    await first.close();
    const second = await createTinybaseScopePlane({ file });
    const restored = await second.plane.read("root");
    expect(restored?.kv.color).toBe("blue");
    await second.close();
  });
});
