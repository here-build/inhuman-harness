import { describe, expect, it } from "vitest";

import { activateThroughLoad, flushMicrotasks, makeHost } from "./_helpers/test-host.js";

describe("the updates plane", () => {
  it("a retracted lane before the outcome write still shows the last frame", async () => {
    using bag = makeHost();
    const expectation = bag.host.mint();
    await activateThroughLoad(bag.host, expectation);
    bag.loader.lastActor!.report({ note: "mid" });
    bag.loader.lastActor!.leave();
    await flushMicrotasks();
    expect(expectation.outcome).toBeNull();
    expect(expectation.workerPresent).toBe(false);
    expect(expectation.report).toEqual({ note: "mid" });
  });

  it("reports after settlement are ignored (streams close at settle)", async () => {
    using bag = makeHost();
    const expectation = bag.host.mint();
    await activateThroughLoad(bag.host, expectation);
    bag.loader.lastActor!.report({ note: "kept" });
    bag.loader.lastActor!.complete({ value: "ok" });
    bag.loader.lastActor!.report({ note: "too late" });
    await flushMicrotasks();
    expect(expectation.report).toEqual({ note: "kept" });
  });

  it("cancel keeps the last frame", async () => {
    using bag = makeHost();
    const expectation = bag.host.mint();
    await activateThroughLoad(bag.host, expectation);
    bag.loader.lastActor!.report({ note: "mid-flight" });
    bag.host.actorOf(expectation)!.admitTermination();
    expect(expectation.endCause).toBe("cancel");
    expect(expectation.report).toEqual({ note: "mid-flight" });
  });
});
