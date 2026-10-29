import { describe, expect, it } from "vitest";

import { DAEMON_UNREACHABLE } from "./copy.js";
import {
  actLine,
  answerParams,
  attentionKind,
  attentionSections,
  attentionTone,
  botGroups,
  countWaiting,
  isAccepted,
  isListed,
  matchesQuery,
  orderedIds,
  projectStatus,
  sessionProblem,
  turnParams,
  waitingSections,
  waitingTitle,
  type Glance,
} from "./directory.js";
import { armCover, confirmCover, seatForAsk } from "../../harness-web-app/src/shell/cover.js";
import { overviewLight } from "../../harness-web-app/src/shell/light.js";

const now = 1_700_000_000_000;

const glances: Record<string, Glance> = {
  wait: {
    title: "Ship",
    unfinished: "ask",
    askLine: "Delete the cache",
    lastMessageAt: now - 5_000,
    status: "waiting",
  },
  run: { title: "Build", openTurn: true, lastMessageAt: now - 1_000, status: "running" },
  idle: { title: "Notes", lastMessageAt: now - 86_400_000, status: "idle" },
  stale: { title: "Frozen", openTurn: true, lastMessageAt: now - 49 * 60 * 60 * 1000, status: "running" },
  recipe: { title: "Nightly", recipeScope: "eval", status: "running" },
};

const light = (id: string) => overviewLight(glances[id], now);
const at = (id: string) => glances[id].lastMessageAt ?? 0;

describe("phone client scenario", () => {
  it("orders a project the way the browser rail does", () => {
    expect(orderedIds(["idle", "run", "wait", "stale"], light, at)).toEqual(["wait", "run", "idle", "stale"]);
    expect(light("stale")).toBe("idle");
    expect(isListed(glances.recipe)).toBe(false);
    expect(isListed(undefined)).toBe(false);
    expect(projectStatus(["idle", "running", "waiting-for-you"])).toEqual({
      waiting: 1,
      light: "waiting-for-you",
    });
  });

  it("groups decisions under their project and counts each session once", () => {
    const sections = waitingSections(
      [
        { path: "/work/app", name: "app", sessionIds: ["wait", "run"] },
        { path: "/work/web", name: "web", sessionIds: ["idle"] },
      ],
      ["wait", "loose"],
      (id) => (id === "loose" ? "waiting-for-you" : light(id)),
      at,
    );
    expect(sections.map((section) => [section.name, section.sessionIds])).toEqual([
      ["app", ["wait"]],
      ["Global", ["loose"]],
    ]);
    expect(countWaiting(["wait", "wait", "run"], light)).toBe(1);
    expect(waitingTitle(glances.wait)).toBe("Delete the cache");
    expect(matchesQuery("cache", ["Delete the cache", "app"])).toBe(true);
    expect(matchesQuery("zzz", ["Delete the cache"])).toBe(false);
  });

  it("names the act once and writes the decision the daemon already accepts", () => {
    expect(actLine({ command: "rm -rf tmp", path: "tmp" })).toBe("rm -rf tmp");
    expect(actLine({ path: "src/app.tsx" })).toBe("src/app.tsx");
    expect(actLine(null)).toBe("");
    expect(turnParams("hello")).toEqual({ prompt: "hello" });
    expect(turnParams("hello", [])).toEqual({ prompt: "hello" });
    expect(
      turnParams("", [
        { mime: "image/png", bytesBase64: "aaaa" },
        { mime: "image/jpeg", bytesBase64: "bbbb", sourcePath: null },
        { mime: "image/png", bytesBase64: "cccc", sourcePath: "" },
        { mime: "image/png", bytesBase64: "dddd", sourcePath: "/tmp/d.png" },
      ]),
    ).toEqual({
      prompt: "",
      visuals: [
        { mime: "image/png", bytesBase64: "aaaa" },
        { mime: "image/jpeg", bytesBase64: "bbbb" },
        { mime: "image/png", bytesBase64: "cccc" },
        { mime: "image/png", bytesBase64: "dddd", sourcePath: "/tmp/d.png" },
      ],
    });
    expect(answerParams({ sessionId: "s", jobId: "j", allow: false, comment: "  " })).toEqual({
      sessionId: "s",
      jobId: "j",
      allow: false,
    });
    expect(isAccepted({ ok: true })).toBe(true);
    expect(isAccepted({ ok: false })).toBe(false);
  });

  it("arms a cover immediately on an empty draft and only after the pause when a draft is held", () => {
    const empty = seatForAsk({ phase: "draft", leafId: null }, "job", true, 1000);
    expect(empty.phase).toBe("cover_armed");
    expect(confirmCover(empty, "job")).toBe(true);
    const held = seatForAsk({ phase: "draft", leafId: null }, "job", false, 1000);
    expect(held.phase).toBe("cover_throttled");
    expect(confirmCover(held, "job")).toBe(false);
    expect(confirmCover(armCover(held), "job")).toBe(true);
    expect(seatForAsk(held, "job", false, 1000)).toBe(held);
  });

  it("colors a decision yellow and a failure red, and writes the failure beside its project", () => {
    const failed = { title: "Ship", status: "The build failed.", model: "gpt" };
    const asking = {
      title: "Ship",
      unfinished: "ask" as const,
      askLine: "Delete the cache",
      status: "The build failed.",
    };
    const connections = {
      openai: { name: "ChatGPT", readyState: "failed", error: "connection refused", live: { models: ["gpt"] } },
    };
    expect(attentionKind(asking, connections)).toBe("ask");
    expect(attentionKind(failed, connections)).toBe("bad");
    expect(sessionProblem(failed, connections)).toBe(
      "ChatGPT didn’t answer on this machine. Check it’s running, then retry.",
    );
    expect(attentionTone(["bad"])).toBe("red");
    expect(attentionTone(["ask", "bad"])).toBe("yellow");
    expect(attentionTone([])).toBe("clear");
    const sections = attentionSections(
      [
        { path: "/work/app", name: "app", sessionIds: ["ask", "bad"] },
        { path: "/work/web", name: "web", sessionIds: ["ok"] },
      ],
      [],
      (id) => (id === "ask" ? "ask" : id === "bad" ? "bad" : null),
      () => 0,
    );
    expect(sections).toEqual([{ path: "/work/app", name: "app", sessionIds: ["ask", "bad"] }]);
  });

  it("tells the Simulator to start harness web, and lists bots only where a roster has some", () => {
    expect(DAEMON_UNREACHABLE).toContain("harness web");
    expect(
      botGroups({ nightly: "bot-1" }, [
        { path: "/work/app", name: "app", roster: {} },
        { path: "/work/web", name: "web", roster: { review: "bot-2" } },
      ]),
    ).toEqual([
      { key: "", name: "Global", path: "", bots: [{ name: "nightly", sessionId: "bot-1" }] },
      { key: "/work/web", name: "web", path: "/work/web", bots: [{ name: "review", sessionId: "bot-2" }] },
    ]);
  });
});
