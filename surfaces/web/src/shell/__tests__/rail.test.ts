import { describe, expect, it } from "vitest";

import { harnessCommand } from "../add-project.js";
import { railPane } from "../project-tabs.js";
import { orderSessions, overviewList, shortAge } from "../rail-sessions.js";

describe("shortAge", () => {
  const now = 1_700_000_000_000;
  it("reads minutes, hours, then days", () => {
    expect(shortAge(null, now)).toBe("");
    expect(shortAge(now - 30_000, now)).toBe("1m");
    expect(shortAge(now - 3 * 60_000, now)).toBe("3m");
    expect(shortAge(now - 2 * 60 * 60_000, now)).toBe("2h");
    expect(shortAge(now - 4 * 24 * 60 * 60_000, now)).toBe("4d");
  });
});

describe("orderSessions", () => {
  it("pins waiting, then running, and breaks ties by recency", () => {
    const light = { a: "idle", b: "running", c: "waiting-for-you", d: "idle" } as const;
    const at = { a: 10, b: 1, c: 2, d: 50 };
    const ids = ["a", "b", "c", "d"] as const;
    expect(
      orderSessions(
        ids,
        (id) => light[id],
        (id) => at[id],
      ),
    ).toEqual(["c", "b", "d", "a"]);
  });
});

describe("overviewList", () => {
  it("keeps waiting and running, and otherwise the newest dozen", () => {
    const light = { wait: "waiting-for-you", run: "running", old: "idle", new: "idle" } as const;
    const at = { wait: 1, run: 2, old: 3, new: 9 };
    expect(
      overviewList(
        ["old", "run", "new", "wait"],
        (id) => light[id],
        (id) => at[id],
      ),
    ).toEqual(["wait", "run"]);
    const idle = Array.from({ length: 14 }, (_, index) => `s${index}`);
    expect(
      overviewList(
        idle,
        () => "idle",
        (id) => Number(id.slice(1)),
      ),
    ).toEqual(["s13", "s12", "s11", "s10", "s9", "s8", "s7", "s6", "s5", "s4", "s3", "s2"]);
  });
});

describe("railPane", () => {
  const bots = new Set(["bot-1"]);
  it("follows the route, and a bot session stays on Bots", () => {
    expect(railPane({ kind: "kernel" }, bots, false)).toEqual({ kind: "overview" });
    expect(railPane({ kind: "project", path: "/work" }, bots, false)).toEqual({ kind: "project", path: "/work" });
    expect(railPane({ kind: "session", sessionId: "loose" }, bots, false)).toEqual({ kind: "bots" });
    expect(railPane({ kind: "project-session", path: "/work", sessionId: "bot-1" }, bots, false)).toEqual({
      kind: "bots",
    });
    expect(railPane({ kind: "project", path: "/work" }, bots, true)).toEqual({ kind: "bots" });
  });
});

describe("harnessCommand", () => {
  it("is the bare command, or cd into a typed directory", () => {
    expect(harnessCommand("")).toBe("harness");
    expect(harnessCommand("  /tmp/a b  ")).toBe("cd '/tmp/a b'\nharness");
    expect(harnessCommand("/tmp/it's")).toBe("cd '/tmp/it'\\''s'\nharness");
  });
});
