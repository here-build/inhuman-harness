import { ReACTChunk, ResponseCall, responseCall, TurnNotificationChunk } from "@inhuman.tools/harness-model";
import { historyBehind } from "@/context";
import { describe, expect, it } from "vitest";

import { LENGTH_CONTINUE_NOTE } from "../re-act-loop-intent-detected-trigger.js";
import { maxRoundsMessage } from "../round-stop.js";
import type { TurnIteratorHost } from "../turn-iterator.js";
import { turnFixture } from "./fixtures/turn-iterator.js";

/** The kind of early stop, read from the one place a turn records it: `broke`. */
const stopKind = (turn: ReturnType<typeof turnFixture>["turn"]) =>
  turn.broke === ""
    ? ""
    : turn.broke.includes("content filter")
      ? "content_filter"
      : turn.broke.includes("model rounds")
        ? "max_rounds"
        : "length";

const notices = (turn: ReturnType<typeof turnFixture>["turn"]) =>
  turn.doneWork
    .filter((cell): cell is TurnNotificationChunk => cell instanceof TurnNotificationChunk)
    .map((cell) => cell.notificationText());

describe("round cap", () => {
  it("is unlimited by default and records the cap it started with", async () => {
    const f = turnFixture(
      (c) => void c.responseCalls.push(responseCall("t1", "echo", "{}")),
      (c) => void c.responseCalls.push(responseCall("t2", "echo", "{}")),
      (c) => void (c.responseText = "Done."),
    );
    await f.run();
    expect({ cap: f.turn.maxRounds, rounds: f.turn.rounds, stop: stopKind(f.turn) }).toEqual({
      cap: 0,
      rounds: 3,
      stop: "",
    });
  });

  it("stops cleanly at maxRounds with a recorded reason on the tape", async () => {
    const f = turnFixture(
      (c) => void c.responseCalls.push(responseCall("t1", "echo", "{}")),
      (c) => void c.responseCalls.push(responseCall("t2", "echo", "{}")),
    );
    (f.host as TurnIteratorHost).loopLimits = () => ({ maxRounds: 2, lengthContinuations: 3 });
    await f.run();
    expect(f.turn.rounds).toBe(2);
    expect(stopKind(f.turn)).toBe("max_rounds");
    // One field records an early stop, the same one a failed round writes: `broke`.
    expect(f.turn.broke).toBe(maxRoundsMessage(2));
    expect(notices(f.turn)).toEqual([expect.stringContaining("2 model rounds")]);
    expect(f.turn.maxRounds).toBe(2);
  });

  it("keeps the cap it recorded when the setting moves mid-turn", async () => {
    let cap = 5;
    const f = turnFixture(
      (c) => void c.responseCalls.push(responseCall("t1", "echo", "{}")),
      (c) => void c.responseCalls.push(responseCall("t2", "echo", "{}")),
      (c) => void (c.responseText = "Done."),
    );
    (f.host as TurnIteratorHost).loopLimits = () => ({ maxRounds: cap, lengthContinuations: 3 });
    const running = f.run();
    cap = 1;
    await running;
    expect({ cap: f.turn.maxRounds, rounds: f.turn.rounds, stop: stopKind(f.turn) }).toEqual({
      cap: 5,
      rounds: 3,
      stop: "",
    });
  });

  it("shows the stop to the model on the next turn", async () => {
    const f = turnFixture((c) => void c.responseCalls.push(responseCall("t1", "echo", "{}")));
    (f.host as TurnIteratorHost).loopLimits = () => ({ maxRounds: 1, lengthContinuations: 3 });
    await f.run();
    const eat = historyBehind(f.turn);
    expect(eat.some((cell) => cell instanceof TurnNotificationChunk && cell.notificationText().includes("round"))).toBe(
      true,
    );
  });
});

describe("provider stop reasons", () => {
  it("continues an answer cut off by the output limit, noting why", async () => {
    const f = turnFixture(
      (c) => {
        c.responseText = "The first half";
        c.finishReason = "length";
      },
      (c) => void (c.responseText = " and the second."),
    );
    await f.run();
    expect(f.completions()).toHaveLength(2);
    expect(f.completions()[0]?.expectation.finishReason).toBe("length");
    const continued = f.turn.doneWork.find((cell) => cell instanceof ReACTChunk && cell.truncated);
    expect(continued).toBeDefined();
    expect(f.completions()[1]?.expectation.systemNote).toContain(LENGTH_CONTINUE_NOTE);
    expect(stopKind(f.turn)).toBe("");
    expect(f.host.classifyIntent).toHaveBeenCalledTimes(1);
  });

  it("stops after lengthContinuations rounds in a row and says so", async () => {
    const cut = (c: { responseText: string; finishReason: string }) => {
      c.responseText = "more";
      c.finishReason = "length";
    };
    const f = turnFixture(cut, cut, cut);
    (f.host as TurnIteratorHost).loopLimits = () => ({ maxRounds: 0, lengthContinuations: 2 });
    await f.run();
    expect(f.completions()).toHaveLength(3);
    expect(stopKind(f.turn)).toBe("length");
    expect(notices(f.turn)).toEqual([expect.stringContaining("output limit")]);
  });

  it("does not continue when lengthContinuations is 0", async () => {
    const f = turnFixture((c) => {
      c.responseText = "cut";
      c.finishReason = "length";
    });
    (f.host as TurnIteratorHost).loopLimits = () => ({ maxRounds: 0, lengthContinuations: 0 });
    await f.run();
    expect(f.completions()).toHaveLength(1);
    expect(stopKind(f.turn)).toBe("length");
  });

  it("is bounded by maxRounds", async () => {
    const cut = (c: { responseText: string; finishReason: string }) => {
      c.responseText = "more";
      c.finishReason = "length";
    };
    const f = turnFixture(cut, cut);
    (f.host as TurnIteratorHost).loopLimits = () => ({ maxRounds: 2, lengthContinuations: 9 });
    await f.run();
    expect(f.completions()).toHaveLength(2);
    expect(stopKind(f.turn)).toBe("max_rounds");
  });

  it("stops, and records it, when a reasoning model spends its whole budget thinking", async () => {
    const f = turnFixture((c) => {
      c.responseThought = "hmm";
      c.finishReason = "length";
    });
    await f.run();
    expect(f.completions()).toHaveLength(1);
    expect(stopKind(f.turn)).toBe("length");
    expect(notices(f.turn)[0]).toContain("reasoning");
    expect(f.turn.doneWork.some((cell) => cell instanceof ReACTChunk && cell.intentContinue)).toBe(false);
  });

  it("still nudges a thought-only round that did not hit the limit", async () => {
    const f = turnFixture(
      (c) => void (c.responseThought = "hmm"),
      (c) => void (c.responseText = "Answer."),
    );
    await f.run();
    expect(f.completions()).toHaveLength(2);
  });

  it("surfaces a content-filtered response as its own stop, not an empty answer", async () => {
    const f = turnFixture((c) => void (c.finishReason = "content_filter"));
    await f.run();
    expect(stopKind(f.turn)).toBe("content_filter");
    expect(notices(f.turn)[0]).toContain("content filter");
    expect(f.host.classifyIntent).not.toHaveBeenCalled();
    expect(f.completions()).toHaveLength(1);
  });

  it("does not run calls from a filtered response, and answers each with a receipt", async () => {
    const f = turnFixture((c) => {
      c.finishReason = "content_filter";
      c.responseCalls.push(responseCall("t1", "echo", "{}"));
    });
    await f.run();
    expect(f.host.admit).not.toHaveBeenCalled();
    const job = f.turn.doneWork.find((cell) => "toolCallId" in cell && cell.toolCallId === "t1");
    expect(job).toMatchObject({ completed: true });
    expect(stopKind(f.turn)).toBe("content_filter");
  });

  it("tells the model a truncated call was cut off, and runs it never", async () => {
    const f = turnFixture(
      (c) => {
        c.finishReason = "length";
        c.responseCalls.push(
          responseCall("whole", "echo", "{}"),
          new ResponseCall({ toolCallId: "cut", name: "write_file", argsJson: "{}", dropReason: "truncated" }),
        );
      },
      (c) => void (c.responseText = "Re-issued."),
    );
    await f.run();
    expect(f.host.admit).toHaveBeenCalledTimes(1);
    const cut = f.turn.doneWork.find((cell) => "toolCallId" in cell && cell.toolCallId === "cut");
    expect(cut).toMatchObject({ completed: true, name: "write_file" });
    expect(JSON.parse((cut as { receiptJson: string }).receiptJson)).toMatchObject({
      ok: false,
      text: expect.stringContaining("truncated"),
    });
    // The round is not treated as text-only: the loop continues so the model can re-issue.
    expect(f.completions()).toHaveLength(2);
    expect(stopKind(f.turn)).toBe("");
  });
});

describe("call order on the jobs", () => {
  it("stamps `after` from the response order, not from a scheduler", async () => {
    const f = turnFixture(
      (c) => {
        c.responseCalls.push(
          responseCall("a", "shell", '{"command":"x"}'),
          responseCall("b", "edit_file", '{"path":"src/a.ts"}'),
          responseCall("c", "read_file", '{"path":"src/other.ts"}'),
          responseCall("d", "shell", '{"command":"y"}'),
          // A read of a file the response edits waits for that edit, and only for it.
          responseCall("e", "read_file", '{"path":"src/a.ts"}'),
        );
      },
      (c) => void (c.responseText = "Done."),
    );
    await f.run();
    const jobs = f.host.admit.mock.results.map((r) => r.value as { toolCallId: string; after: Array<{ toolCallId: string }> });
    const afters = Object.fromEntries(jobs.map((j) => [j.toolCallId, j.after.map((x) => x.toolCallId)]));
    expect(afters).toEqual({ a: [], b: ["a"], c: [], d: ["a", "b"], e: ["b"] });
  });
});
