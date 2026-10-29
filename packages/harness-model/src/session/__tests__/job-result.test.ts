import { expect, test } from "vitest";

import { AgentCallJob } from "../jobs/AgentCallJob.js";
import { FailureOutcome, SuccessfulOutcome } from "../jobs/CallOutcome.js";
import { CompactJob } from "../jobs/CompactJob.js";
import { SystemToolJob } from "../jobs/SystemToolJob.js";

test("compact fulfills the card and rejects a failure", async () => {
  const done = new CompactJob({ standIn: "summary" });
  const pending = done.then((card: string) => card);
  done.markComplete(1);
  await expect(pending).resolves.toBe("summary");

  const failed = new CompactJob({ failed: true, notice: "" });
  failed.markComplete(1);
  await expect(failed).rejects.toBe("compact failed");
});

test("a tool fulfills its value, rejects its text, and stays pending until it ends", async () => {
  const open = new SystemToolJob({
    toolCallId: "t",
    name: "read_file",
    outcomeJson: JSON.stringify({ ok: false, text: "", code: "denied" }),
  });
  let settled = false;
  const waiting = open.then(() => {
    settled = true;
    return false;
  });
  await Promise.resolve();
  expect(settled).toBe(false);

  open.markComplete(1);
  await expect(waiting).rejects.toBe("denied");

  const ok = new SystemToolJob({
    toolCallId: "u",
    name: "read_file",
    outcomeJson: JSON.stringify({ ok: true, value: { n: 1 } }),
  });
  ok.markComplete(1);
  await expect(ok).resolves.toEqual({ n: 1 });

  const empty = new SystemToolJob({ toolCallId: "v", name: "read_file" });
  empty.markComplete(1);
  await expect(empty).resolves.toBeUndefined();
});

test("an ask fulfills its value and rejects cancel, failure, and a missing outcome", async () => {
  const open = new AgentCallJob({ name: "agent__ask", argsJson: "{}" });
  let settled = false;
  const waiting = open.then(() => {
    settled = true;
    return false;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  open.cancelled = true;
  await expect(waiting).rejects.toBe("dotprompt/run: ask cancelled");

  const structured = new AgentCallJob({ name: "agent__ask", argsJson: "{}", responseSchema: {} });
  structured.settleResult(new SuccessfulOutcome({ valueJson: JSON.stringify({ decision: "allow" }) }));
  await expect(structured).resolves.toEqual({ decision: "allow" });

  const fromValue = new AgentCallJob({
    name: "agent__ask",
    argsJson: "{}",
    responseSchema: {},
    outcome: new SuccessfulOutcome({ valueJson: JSON.stringify({ n: 1 }) }),
  });
  fromValue.markComplete(1);
  await expect(fromValue).resolves.toEqual({ n: 1 });

  const prose = new AgentCallJob({
    name: "agent__ask",
    argsJson: "{}",
    outcome: new SuccessfulOutcome({ valueJson: JSON.stringify("hi") }),
  });
  prose.markComplete(1);
  await expect(prose).resolves.toBe("hi");

  const denied = new AgentCallJob({
    name: "agent__ask",
    argsJson: "{}",
    outcome: new FailureOutcome({ code: "denied", message: "  " }),
  });
  denied.markComplete(1);
  await expect(denied).rejects.toBe("denied");

  const bare = new AgentCallJob({ name: "agent__ask", argsJson: "{}" });
  bare.markComplete(1);
  await expect(bare).rejects.toBe("ask failed");
});
