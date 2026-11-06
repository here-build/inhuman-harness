import { describe, expect, it } from "vitest";

import { overviewLight, projectPulse, rowLight, RUNNING_GLANCE_MS, sessionLight, turnIsLive } from "../light.js";

describe("live turn", () => {
  it("treats a cancel as idle chrome", () => {
    expect(turnIsLive(null)).toBe(false);
    expect(turnIsLive({ cutOff: false })).toBe(true);
    expect(turnIsLive({ cutOff: true })).toBe(false);
    expect(sessionLight(null)).toBe("idle");
  });
});

describe("a session the tab is not attached to", () => {
  const now = 1_700_000_000_000;
  const fresh = now - 60_000;
  const weeks = now - 32 * 24 * 60 * 60 * 1000;

  it("waits on an ask or a question, and runs only a turn admitted recently", () => {
    expect(
      (["ask", "question", "tools", "turn", ""] as const).map((unfinished) =>
        overviewLight({ unfinished, openTurn: true, lastMessageAt: fresh }, now),
      ),
    ).toEqual(["waiting-for-you", "waiting-for-you", "running", "running", "running"]);
    expect(overviewLight({ unfinished: "tools", openTurn: false, lastMessageAt: fresh }, now)).toBe("idle");
    expect(overviewLight({ unfinished: "turn", openTurn: true, lastMessageAt: weeks }, now)).toBe("idle");
    expect(overviewLight({ unfinished: "turn", openTurn: true }, now)).toBe("idle");
    expect(overviewLight({ unfinished: "ask", lastMessageAt: weeks }, now)).toBe("waiting-for-you");
    expect(overviewLight({ openTurn: true, lastMessageAt: now - RUNNING_GLANCE_MS }, now)).toBe("idle");
    expect(overviewLight(undefined, now)).toBe("idle");
  });

  it("prefers the attached room over the glance, which can lag it", () => {
    expect(projectPulse(["idle", "running", "waiting-for-you"])).toBe("waiting-for-you");
    expect(projectPulse(["idle", "running"])).toBe("running");
    expect(projectPulse(["idle"])).toBe("idle");
    expect(rowLight(null, { unfinished: "turn", openTurn: true, lastMessageAt: Date.now() - 60_000 })).toBe("running");
    expect(rowLight(null, { unfinished: "tools", openTurn: false, lastMessageAt: fresh })).toBe("idle");
    expect(rowLight({ findRunningTurn: () => null, unfinished: "" } as never, { unfinished: "turn" })).toBe("idle");
  });
});
