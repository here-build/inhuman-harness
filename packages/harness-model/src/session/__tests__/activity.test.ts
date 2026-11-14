import { describe, expect, it } from "vitest";

import { CompletionExpectation } from "../expectations/CompletionExpectation.js";
import { CompletionJob } from "../jobs/CompletionJob.js";
import { SessionPlexus } from "../SessionPlexus.js";
import { SessionSystemPrompt } from "../SessionSystemPrompt.js";
import { SessionTurn } from "../turn/session-turn.js";

describe("session activity", () => {
  it("prefers the current provider over a predecessor's unfinished isolated completion", () => {
    const session = SessionPlexus.create("activity-current");
    try {
      const old = new CompletionJob({
        expectation: new CompletionExpectation({ connectionId: "c", completionMode: "isolated" }),
        background: true,
      });
      const previous = new SessionTurn({ turnTail: new SessionSystemPrompt(), queue: [], reducerExited: true });
      previous.pushChild(old);
      const expectation = new CompletionExpectation({ connectionId: "c" });
      expectation.phase = "responding";
      const current = new SessionTurn({
        turnTail: previous,
        queue: [],
        doneWork: [new CompletionJob({ expectation })],
      });
      session.root.head = current;
      expect(session.root.activity.kind).toBe("responding");
    } finally {
      session.destroy();
    }
  });
  it("projects provider phases and failed attempts through a stored replica", () => {
    const session = SessionPlexus.create("activity");
    try {
      const expectation = new CompletionExpectation({ connectionId: "c" });
      const job = new CompletionJob({ expectation });
      const turn = new SessionTurn({ turnTail: new SessionSystemPrompt(), doneWork: [job], queue: [] });
      session.root.head = turn;
      expect(session.root.activity.kind).toBe("waiting");
      expectation.phase = "thinking";
      expect(session.root.activity.kind).toBe("thinking");
      expectation.phase = "responding";
      expect(session.root.activity.kind).toBe("responding");
      expectation.recordAttemptFailure("Connection timed out");
      expectation.retryUntilMs = Date.now() + 1_000;
      const copy = SessionPlexus.fromNodeRows(session.doc.toNodeRows(), {
        sessionId: "activity",
        rootId: session.root.uuid,
      });
      try {
        const activity = copy.root.activity;
        expect(activity.kind).toBe("retrying");
        expect("completion" in activity && activity.completion.foregroundFailures).toBe(1);
        expect("completion" in activity && activity.completion.lastAttemptError).toBe("Connection timed out");
      } finally {
        copy.destroy();
      }
      expectation.fail("settled", "connection failed", "null");
      turn.broke = "Connection failed. Resume to try again.";
      turn.reducerExited = true;
      expect(session.root.activity).toEqual({ kind: "stopped", detail: turn.broke });
    } finally {
      session.destroy();
    }
  });
});
