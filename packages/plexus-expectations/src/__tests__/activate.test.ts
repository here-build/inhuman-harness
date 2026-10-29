import { afterEach, describe, expect, it } from "vitest";

import {
  activateThroughLoad,
  flushMicrotasks,
  makeHost,
  PewTestHost,
  TestExpectation,
  ThrowingSpawnLoader,
} from "./_helpers/test-host.js";

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup) fn();
  cleanup = [];
});

describe("activation", () => {
  it("honor occupies the role lane without settling — empty occupancy is not a frame", async () => {
    using bag = makeHost();
    const expectation = bag.host.mint();
    await activateThroughLoad(bag.host, expectation);
    expect(expectation.outcome).toBeNull();
    expect(expectation.workerPresent).toBe(true);
    expect(expectation.progressAwareness).toBeNull();
    expect(bag.host.actorOf(expectation)).toBeDefined();
  });

  it("failed load(): work stays open, connection reports failed, no hot loop", async () => {
    using bag = makeHost();
    bag.loader.failLoad = new Error("weights missing");
    const expectation = bag.host.mint();
    await activateThroughLoad(bag.host, expectation);
    expect(expectation.outcome).toBeNull();
    expect(bag.host.catalogDrivers[0]!.readyState).toBe("ready");
    expect(bag.host.catalogFaces[0]!.readyState).toBe("failed");
    expect(bag.host.catalogFaces[0]!.error).toContain("weights missing");
    await flushMicrotasks();
    expect(bag.loader.loadCalls).toBe(1);
  });

  it("spawn throw breaks the connection; the expectation stays unspawned", async () => {
    const host = new PewTestHost();
    cleanup.push(() => host[Symbol.dispose]());
    const loader = new ThrowingSpawnLoader();
    host.register({ name: "test" }, loader);
    const expectation = host.mint();
    await activateThroughLoad(host, expectation);
    expect(expectation.outcome).toBeNull();
    expect(host.actorOf(expectation)).toBeUndefined();
    expect(host.catalogFaces[0]!.readyState).toBe("failed");
    await flushMicrotasks();
    expect(loader.spawnCalls).toBe(1);
  });

  it("a settlement emitted synchronously inside spawn writes the outcome", async () => {
    using bag = makeHost((actor) => {
      actor.complete({ value: "quick" });
    });
    const expectation = bag.host.mint();
    await activateThroughLoad(bag.host, expectation);
    await flushMicrotasks();
    expect(expectation.outcome).toBe("successful");
    expect(expectation.resultValue).toBe("quick");
  });

  it("synchronous re-entry during spawn cannot bind a handle to a done entity", async () => {
    using bag = makeHost();
    const expectation = bag.host.mint();
    bag.loader.onSpawn = () => {
      expectation.fail("cancel", "", "null");
    };
    await activateThroughLoad(bag.host, expectation);
    expect(expectation.outcome).toBe("failed");
    expect(bag.host.actorOf(expectation)).toBeUndefined();
    expect(expectation.workerPresent).toBe(false);
  });

  it("an already-honored expectation is not spawned again", async () => {
    using bag = makeHost();
    const expectation = bag.host.mint();
    await activateThroughLoad(bag.host, expectation);
    expect(bag.loader.spawnCalls).toBe(1);
    await flushMicrotasks();
    expect(bag.loader.spawnCalls).toBe(1);
  });

  it("unknown connection is skipped — no spawn, no throw", async () => {
    using bag = makeHost();
    const expectation = bag.host.mint(new TestExpectation({ connectionId: "ghost" }));
    await flushMicrotasks();
    expect(expectation.outcome).toBeNull();
    expect(bag.loader.spawnCalls).toBe(0);
  });
});
