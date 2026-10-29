import { ScopeCycle, ScopeKey, ScopeMissing, type ScopePlane, type ScopeView } from "@inhuman.tools/scope-plane";
import { describe, expect, it } from "vitest";

import { createElectricScopePlane } from "../index.js";
import { createSqlDouble } from "./sql-double.js";

const glance = {
  sessionId: "sess-1",
  scopeId: "root",
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

function open(): { plane: ScopePlane; texts: string[] } {
  const sql = createSqlDouble();
  return { plane: createElectricScopePlane({ sql, shapes: sql.shapes }), texts: sql.texts };
}

describe("electric", () => {
  it("overlays parent config through SQL and keeps the roster unique", async () => {
    const { plane, texts } = open();
    await plane.ensureScope({ id: "root", parentId: null, path: null });
    await plane.ensureScope({ id: "child", parentId: "root", path: "/work" });
    expect(await plane.publishConfig("root", 0, { defaultPermissionMode: "manual", compactKeepTurns: 4 })).toBe(1);
    expect(await plane.publishConfig("child", 0, { defaultPermissionMode: "ask" })).toBe(1);
    await plane.putKv("child", "color", "red");
    expect(await plane.insertRoster("child", "echo", "child-bot")).toBe(true);
    expect(await plane.insertRoster("child", "echo", "other")).toBe(false);
    const view = await plane.read("child");
    expect(view).toMatchObject({
      path: "/work",
      chain: ["root", "child"],
      config: { defaultPermissionMode: "ask", compactKeepTurns: 4 },
      kv: { color: "red" },
      roster: { echo: "child-bot" },
    });
    expect(await plane.publishConfig("child", 1, { statusline: "git" })).toBe(2);
    expect(texts.some((text) => text.includes("WHERE NOT EXISTS"))).toBe(true);
    expect(texts.some((text) => text.startsWith("UPDATE config SET") && text.includes("AND generation ="))).toBe(true);
  });

  it("rejects a stale lease and wakes from the shape", async () => {
    const { plane } = open();
    await plane.ensureScope({ id: "root", parentId: null, path: null });
    expect(await plane.claimGeneration("sess", "root", 0, "worker-a")).toBe(1);
    expect(await plane.claimGeneration("sess", "root", 0, "worker-b")).toBeNull();
    expect(await plane.releaseGeneration("sess", 1, "worker-b")).toBe(false);
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
    await plane.writeOverview(glance);
    const view = await seen;
    stop();
    expect(view?.overviews.map((row) => row.sessionId)).toEqual(["sess-1"]);
  });

  it("refuses a cycle and a NUL key", async () => {
    const { plane } = open();
    await plane.ensureScope({ id: "child", parentId: "gone", path: null });
    await expect(plane.read("child")).rejects.toBeInstanceOf(ScopeMissing);
    await plane.ensureScope({ id: "a", parentId: "b", path: null });
    await plane.ensureScope({ id: "b", parentId: "a", path: null });
    await expect(plane.read("a")).rejects.toBeInstanceOf(ScopeCycle);
    await expect(plane.putKv("a", "bad\0key", "x")).rejects.toBeInstanceOf(ScopeKey);
  });

  it("keeps pane, usage, and calls on this scope and overlays last-used models", async () => {
    const { plane } = open();
    await plane.ensureScope({ id: "root", parentId: null, path: null });
    await plane.ensureScope({ id: "child", parentId: "root", path: "/work", trusted: true, contentHash: "abc" });
    await plane.putTermContinue("child", "desk", "sess-1");
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
    const view = await plane.read("child");
    expect(view).toMatchObject({
      trusted: true,
      contentHash: "abc",
      termContinue: { desk: "sess-1" },
      modelsUsage: { "grok/grok-4": 9 },
      lastUsedConnectionModel: { grok: "grok-4", openai: "gpt" },
    });
    expect(view?.agentCalls.map((call) => call.callId)).toEqual(["call-1"]);
    await plane.removeAgentCall("call-1");
    const cleared = await plane.read("child");
    expect(cleared?.agentCalls).toEqual([]);
  });
});
