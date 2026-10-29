import { describe, expect, it } from "vitest";

import { activateThroughLoad, flushMicrotasks, makeHost, TestParent, TestExpectation } from "./_helpers/test-host.js";

describe("supervision", () => {
  it("a tree orphan with no worker is not started", async () => {
    using bag = makeHost();
    const { host, connection, loader } = bag;
    const parent = host.mint(new TestParent({ connectionId: connection.name }));
    await activateThroughLoad(host, parent);
    parent.fail("crash", "old crash", "null");
    await flushMicrotasks();

    const judge = new TestExpectation({ connectionId: connection.name });
    parent.nested["auto"] = judge;
    const spawnsBefore = loader.spawnCalls;
    await flushMicrotasks();

    expect(judge.outcome).toBeNull();
    expect(loader.spawnCalls).toBe(spawnsBefore);
    expect(host.actorOf(judge)).toBeUndefined();
  });

  it("open work with no local actor is not failed by honor", async () => {
    using bag = makeHost();
    const { host } = bag;
    const expectation = host.mint();
    await flushMicrotasks();
    expect(expectation.outcome).toBeNull();
    expect(expectation.endCause).toBeNull();
  });
});
