import { afterEach, describe, expect, it } from "vitest";

import { ConnectionNotReady, DemandIncomplete } from "../driver/index.js";
import {
  activateThroughLoad,
  flushMicrotasks,
  makeHost,
  PewTestHost,
  TestParent,
  TestExpectation,
  TestLoader,
  ThrowingExpectation,
} from "./_helpers/test-host.js";

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup) fn();
  cleanup = [];
});

describe("endings", () => {
  it("actor start stamps startedAt; settle stamps endedAt", async () => {
    using bag = makeHost();
    const expectation = bag.host.mint();
    await activateThroughLoad(bag.host, expectation);
    expect(expectation.startedAtMs).toEqual(expect.any(Number));
    expect(expectation.endedAtMs).toBeNull();
    bag.loader.lastActor!.complete({ value: "done" });
    expect(expectation.endedAtMs).toEqual(expect.any(Number));
    expect(expectation.endedAtMs!).toBeGreaterThanOrEqual(expectation.startedAtMs!);
    expect(expectation.durationMs()).toBe(expectation.endedAtMs! - expectation.startedAtMs!);
  });

  it("parent cancel does not cascade to a live child", async () => {
    using bag = makeHost();
    const parent = new TestParent({ connectionId: bag.connection.name });
    const judge = new TestExpectation({ connectionId: bag.connection.name });
    parent.nested["auto"] = judge;
    bag.host.mint(parent);
    await activateThroughLoad(bag.host, parent);
    await activateThroughLoad(bag.host, judge);

    bag.host.actorOf(parent)!.admitTermination();
    expect(parent.endCause).toBe("cancel");
    await flushMicrotasks();
    expect(judge.outcome).toBeNull();
    expect(bag.host.actorOf(judge)).toBeDefined();
  });

  it("a late admitTermination on settled work is a no-op", async () => {
    using bag = makeHost();
    const expectation = bag.host.mint();
    await activateThroughLoad(bag.host, expectation);
    bag.loader.lastActor!.complete({ value: "done" });
    bag.loader.lastActor!.admitTermination();
    expect(expectation.outcome).toBe("successful");
    expect(expectation.endCause).toBe("settled");
  });

  it("a settled judge keeps its settlement; supervision skips done judges", async () => {
    using bag = makeHost();
    const parent = new TestParent({ connectionId: bag.connection.name });
    const judge = new TestExpectation({ connectionId: bag.connection.name });
    parent.nested["auto"] = judge;
    bag.host.mint(parent);
    await activateThroughLoad(bag.host, judge);
    bag.loader.lastActor!.complete({ value: "judge-done" });

    bag.host.actorOf(parent)!.admitTermination();
    await flushMicrotasks();
    expect(judge.outcome).toBe("successful");
    expect(judge.resultValue).toBe("judge-done");
    expect(parent.outcome).toBe("failed");
  });

  it("abort-reaction settlements are NOT honored (the ending precedes the abort)", async () => {
    using bag = makeHost((actor) => {
      actor.signal.addEventListener("abort", () => actor.complete({ value: "flushed on abort" }));
    });
    const expectation = bag.host.mint();
    await activateThroughLoad(bag.host, expectation);
    bag.host.actorOf(expectation)!.admitTermination();
    expect(expectation.outcome).toBe("failed");
    expect(expectation.endCause).toBe("cancel");
    await flushMicrotasks();
    expect(expectation.outcome).toBe("failed");
  });

  it("ExpectationInvariant is a settled fail, not a crash — sync throw and promise catch", async () => {
    {
      using bag = makeHost(() => {
        DemandIncomplete.invariant(false, "promptText");
      });
      const expectation = bag.host.mint();
      await activateThroughLoad(bag.host, expectation);
      await flushMicrotasks();
      expect(expectation.endCause).toBe("settled");
      expect(expectation.endDetail).toBe("demand missing promptText");
      await expect(bag.loader.lastActor!.settled).resolves.toEqual({
        outcome: "fail",
        reason: expect.any(DemandIncomplete),
      });
    }
    {
      using bag = makeHost(async () => {
        ConnectionNotReady.invariant(false, "acp");
      });
      const expectation = bag.host.mint();
      await activateThroughLoad(bag.host, expectation);
      await flushMicrotasks();
      expect(expectation.endCause).toBe("settled");
      expect(expectation.endDetail).toBe("acp connection not ready");
      await expect(bag.loader.lastActor!.settled).resolves.toEqual({
        outcome: "fail",
        reason: expect.any(ConnectionNotReady),
      });
    }
  });

  it("a frame that fails to serialize crashes the actor and keeps the last GOOD frame", async () => {
    using bag = makeHost();
    const expectation = bag.host.mint();
    await activateThroughLoad(bag.host, expectation);
    bag.loader.lastActor!.report({ note: "good" });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    bag.loader.lastActor!.report(circular);
    await flushMicrotasks();
    expect(expectation.endCause).toBe("crash");
    expect(expectation.report).toEqual({ note: "good" });
  });

  it("applySettlement throw: the work failed — recording the result is part of succeeding", async () => {
    const host = new PewTestHost();
    cleanup.push(() => host[Symbol.dispose]());
    const loader = new TestLoader();
    const id = host.register("test", loader);
    const expectation = host.mint(new ThrowingExpectation({ connectionId: id }));
    await activateThroughLoad(host, expectation);
    loader.lastActor!.complete({ value: "partial" });
    await flushMicrotasks();
    expect(expectation.outcome).toBe("failed");
    expect(expectation.endDetail).toContain("apply_error");
    expect(expectation.resultValue).toBe("partial");
  });
});
