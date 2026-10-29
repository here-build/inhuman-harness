import { resetLocalIDs } from "@here.build/plexus";
import { beforeEach, describe, expect, it } from "vitest";

import { liveBackgroundJobs } from "../background-jobs.js";
import { AgentCallJob } from "../jobs/AgentCallJob.js";
import { BotCallJob } from "../jobs/BotCallJob.js";
import { CallJob } from "../jobs/CallJob.js";
import { SuccessfulOutcome } from "../jobs/CallOutcome.js";
import { applyCancelReceipt, applyDenyReceipt, cancelUnstarted } from "../outcome-receipts.js";

describe("call ownership", () => {
  beforeEach(() => resetLocalIDs());

  it("keeps bot acceptance separate from terminal reply and uses shared receipts", () => {
    const bot = new BotCallJob({ botName: "review", toolCallId: "bot-1", background: true, voidLegal: false });
    expect(bot.acceptPreparedInput({ message: "check" }, "review-session")).toBe(true);
    expect(bot.completed).toBe(false);
    expect(bot.outcome).toBeNull();
    expect(bot.preparedInput).toEqual({ message: "check" });
    expect(bot.workerSessionId).toBe("review-session");
    expect(bot.settleResult(new SuccessfulOutcome({ valueJson: '{"answer":1}' }))).toBe(true);
    expect(bot.acceptPreparedInput({ message: "again" }, "another-session")).toBe(false);
    expect(bot.settleResult(new SuccessfulOutcome({ valueJson: '{"answer":2}' }))).toBe(false);
    expect(bot.observationPayload()).toEqual({ answer: 1 });
    expect(bot.notifications).toHaveLength(1);
    expect(bot.notifications[0]?.result).toBe(true);
    expect(bot.workerSessionId).toBe("review-session");
  });

  it.each([
    ["agent", AgentCallJob],
    ["bot", BotCallJob],
  ] as const)("shares deny and cancel receipts for %s", (_name, Constructor) => {
    const denied = new Constructor({ name: "call" });
    const cancelled = new Constructor({ name: "call" });
    expect(denied).toBeInstanceOf(CallJob);
    applyDenyReceipt(denied);
    applyCancelReceipt(cancelled, "stopped");
    expect(denied.outcomeSnap).toMatchObject({ ok: false, code: "denied" });
    expect(cancelled.outcomeSnap).toMatchObject({ ok: false, code: "cancelled", text: "cancelled" });
  });

  it.each([
    ["foreground", false],
    ["background", true],
  ] as const)("a stored %s rejection is the one outcome every reader sees", (_name, background) => {
    const call = new AgentCallJob({ name: "agent__ask", toolCallId: "call-1", background });
    call.outcomeSnap = { ok: false, text: "rejected" };
    expect({
      sealed: JSON.parse(call.sealedOutcomeJson() ?? "null") as unknown,
      snap: call.outcomeSnap,
      receipt: call.receiptJson != null,
    }).toEqual({
      sealed: { ok: false, text: "rejected", code: "" },
      snap: { ok: false, text: "rejected", code: "" },
      receipt: true,
    });
  });

  it("settles once: a late reply after cancel keeps the cancel and posts one result", async () => {
    const call = new AgentCallJob({
      name: "agent__ask",
      toolCallId: "call-2",
      background: true,
      orchestrationResult: true,
    });
    cancelUnstarted(call, "stopped");
    expect(call.settleResult(new SuccessfulOutcome({ valueJson: '"late"' }))).toBe(false);
    expect(call.settleResult(new SuccessfulOutcome({ valueJson: '"later"' }))).toBe(false);
    expect({
      completed: call.completed,
      snap: call.outcomeSnap,
      notes: call.notifications.map((note) => [note.message, note.result]),
    }).toEqual({
      completed: true,
      snap: { ok: false, text: "cancelled", code: "cancelled" },
      notes: [["job call-2 finished: cancelled", true]],
    });
    await expect(call).rejects.toBe("dotprompt/run: ask cancelled");
  });

  it("tracks background bot requests independently of child invocations", async () => {
    expect(
      await liveBackgroundJobs([
        new AgentCallJob({ name: "agent__ask", toolCallId: "child", background: true }),
        new BotCallJob({ name: "review", toolCallId: "bot", background: true }),
      ]),
    ).toEqual([
      { jobId: "child", kind: "agent", object: "agent__ask" },
      { jobId: "bot", kind: "bot", object: "review" },
    ]);
  });
});
