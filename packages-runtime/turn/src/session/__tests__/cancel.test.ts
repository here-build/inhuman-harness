import { SessionSystemPrompt, SessionTurn, SystemToolJob } from "@inhuman.tools/harness-model";
import { describe, expect, it } from "vitest";

import { failLeftoverApprovables, turnLoopStopped } from "../index.js";
import { emptyCatalog, sessionOf } from "./fixtures.js";

describe("cancel", () => {
  it("turnLoopStopped sees abort, closed, and cancelRequested", () => {
    const turn = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      queue: [],
    });
    const idle = new AbortController();
    expect(turnLoopStopped(turn, idle.signal)).toBe(false);
    turn.cancelRequested = true;
    expect(turnLoopStopped(turn, idle.signal)).toBe(true);
    turn.cancelRequested = false;
    turn.reducerExited = true;
    expect(turnLoopStopped(turn, idle.signal)).toBe(true);
    const aborting = new AbortController();
    aborting.abort("park");
    const open = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      queue: [],
    });
    expect(turnLoopStopped(open, aborting.signal)).toBe(true);
  });

  it("failLeftoverApprovables rejects unstarted and aborts orchestrated", () => {
    const leftover = new SystemToolJob({
      toolCallId: "left",
      name: "echo",
      argsJson: "{}",
    });
    const turn = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      queue: [],
    });
    turn.pushChild(leftover);
    const aborted: unknown[] = [];
    failLeftoverApprovables(turn, (leaf) => aborted.push(leaf), emptyCatalog());
    expect({ cancelled: leftover.cancelled, aborted: aborted.length }).toEqual({
      cancelled: true,
      aborted: 0,
    });
  });

  it("failLeftoverApprovables seals orchestrated leaves, so the session leaves 'tools'", () => {
    const plexus = sessionOf("esc");
    const leaves = ["a", "b", "c"].map(
      (id) => new SystemToolJob({ toolCallId: id, name: "echo", argsJson: "{}", orchestrationResult: true }),
    );
    const turn = new SessionTurn({ turnTail: new SessionSystemPrompt(), queue: [] });
    for (const leaf of leaves) turn.pushChild(leaf);
    plexus.root.head = turn;
    const aborted: unknown[] = [];
    failLeftoverApprovables(turn, (leaf) => aborted.push(leaf), emptyCatalog());
    expect({
      aborted: aborted.length,
      leaves: leaves.map((leaf) => ({ completed: leaf.completed, receipt: JSON.parse(leaf.receiptJson ?? "null") })),
      unfinished: plexus.root.openToolCount,
    }).toEqual({
      aborted: 3,
      leaves: leaves.map(() => ({
        completed: true,
        receipt: expect.objectContaining({ ok: false, text: "cancelled" }),
      })),
      unfinished: 0,
    });
  });
});
