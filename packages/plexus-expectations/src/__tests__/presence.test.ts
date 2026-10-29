import { autorun, observable } from "mobx";
import { afterEach, describe, expect, it } from "vitest";

import { activateThroughLoad, flushMicrotasks, makeHost, PewTestHost, ScriptedActor } from "./_helpers/test-host.js";
import { extraLiveFromState, PEWDriver } from "../driver/index.js";
import { dropConnection } from "../executor/kernel-intern.js";
import { DriverSpec } from "../shared/models/DriverSpec.js";
import type { WorkExpectation } from "../shared/index.js";
import { ROLE_EXPECTATIONS_LANE } from "../shared/types.js";

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup) fn();
  cleanup = [];
});

function namedLiveState() {
  return {
    label: "",
    models: undefined as string[] | undefined,
  };
}

describe("catalog presence", () => {
  it("progressAwareness is last-write: a later frame replaces the earlier", async () => {
    using bag = makeHost();
    const expectation = bag.host.mint();
    await activateThroughLoad(bag.host, expectation);
    bag.loader.lastActor!.report({ note: "one" });
    expect(expectation.progressAwareness).toEqual({ note: "one" });
    bag.loader.lastActor!.report({ note: "two" });
    expect(expectation.progressAwareness).toEqual({ note: "two" });
  });

  it("peer isolation: a report on E2 does not invalidate E1's lane", async () => {
    using bag = makeHost();
    const E1 = bag.host.mint();
    await activateThroughLoad(bag.host, E1);
    const actor1 = bag.loader.lastActor!;
    bag.host.mint();
    await flushMicrotasks();
    const actor2 = bag.loader.lastActor!;
    expect(actor1).not.toBe(actor2);

    let e1Fires = 0;
    const stop = autorun(() => {
      void E1.progressAwareness;
      e1Fires += 1;
    });
    const baseline = e1Fires;
    actor2.report({ note: "peer" });
    expect(E1.progressAwareness).toBeNull();
    expect(e1Fires).toBe(baseline);
    actor1.report({ note: "self" });
    expect(E1.progressAwareness).toEqual({ note: "self" });
    expect(e1Fires).toBeGreaterThan(baseline);
    stop();
  });

  it("extraLiveFromState copies defined extras, omitting undefined", () => {
    expect(extraLiveFromState({ label: "x" })).toEqual({ label: "x" });
    expect(extraLiveFromState({})).toEqual({});
    expect(extraLiveFromState({ label: undefined })).toEqual({});
  });

  it("a bootstrapping remint does not wipe a ready kernel catalog", async () => {
    let releaseBoot!: (models: string[]) => void;
    let boot = new Promise<string[]>((resolve) => {
      releaseBoot = resolve;
    });
    class NamedDriver extends PEWDriver<WorkExpectation, Readonly<Record<string, unknown>>> {
      @observable.shallow override accessor state = namedLiveState();
      async bootstrap(): Promise<void> {
        this.state.models = await boot;
      }
      protected resolve(expectation: WorkExpectation): ScriptedActor {
        return new ScriptedActor(expectation, this);
      }
    }
    class NamedHost extends PewTestHost {
      override async loadDriverModule(_spec: DriverSpec) {
        return NamedDriver;
      }
    }
    const host = new NamedHost();
    cleanup.push(() => host[Symbol.dispose]());
    host.register({ name: "named", importPath: "test:named" }, null);
    const spec = host.kernelRoot.connections.named;
    const first = host.ensure("named");
    releaseBoot(["gpt-6-astra", "gpt-5.5"]);
    await first;
    expect({ ready: spec?.readyState, models: spec?.live.models }).toEqual({
      ready: "ready",
      models: ["gpt-6-astra", "gpt-5.5"],
    });
    await dropConnection(host.kernel.root, "named");
    boot = new Promise<string[]>((resolve) => {
      releaseBoot = resolve;
    });
    const remint = host.ensure("named");
    await flushMicrotasks();
    expect({ ready: spec?.readyState, models: spec?.live.models }).toEqual({
      ready: "ready",
      models: ["gpt-6-astra", "gpt-5.5"],
    });
    releaseBoot(["grok-4.6"]);
    await remint;
    expect(spec?.live.models).toEqual(["grok-4.6"]);
    await dropConnection(host.kernel.root, "named");
    boot = Promise.reject(new Error("handshake failed"));
    await expect(host.ensure("named")).rejects.toThrow("handshake failed");
    expect({ ready: spec?.readyState, error: spec?.error }).toEqual({
      ready: "failed",
      error: "handshake failed",
    });
  });

  it("two sessions intern one connection instance and bootstrap once", async () => {
    let boots = 0;
    let disposed = 0;
    class NamedDriver extends PEWDriver<WorkExpectation, Readonly<Record<string, unknown>>> {
      @observable.shallow override accessor state = namedLiveState();
      async bootstrap(): Promise<void> {
        boots += 1;
        this.state.models = ["m"];
      }
      override async [Symbol.asyncDispose](): Promise<void> {
        disposed += 1;
      }
      protected resolve(expectation: WorkExpectation): ScriptedActor {
        return new ScriptedActor(expectation, this);
      }
    }
    class NamedHost extends PewTestHost {
      override async loadDriverModule(_spec: DriverSpec) {
        return NamedDriver;
      }
    }
    const first = new NamedHost();
    cleanup.push(() => first[Symbol.dispose]());
    first.register({ name: "named", importPath: "test:named" }, null);
    const a = await first.ensure("named");
    const second = first.forkSession();
    cleanup.push(() => second[Symbol.dispose]());
    const b = await second.ensure("named");
    expect(a).toBe(b);
    expect(boots).toBe(1);
    expect(first.kernelRoot.connections["named"]?.live.models).toEqual(["m"]);
    second[Symbol.dispose]();
    expect(disposed).toBe(0);
    expect(a.readyState).toBe("ready");
    first[Symbol.dispose]();
    await flushMicrotasks();
    expect(disposed).toBe(0);
  });

  it("class and instance live faces publish onto kernel catalog getters", async () => {
    class NamedDriver extends PEWDriver<WorkExpectation, Readonly<Record<string, unknown>>> {
      static override readonly state = { label: "named-driver" };
      @observable.shallow override accessor state = namedLiveState();
      async bootstrap(): Promise<void> {
        this.state.label = "named-connection";
        this.state.models = ["m"];
      }
      protected resolve(expectation: WorkExpectation): ScriptedActor {
        return new ScriptedActor(expectation, this);
      }
    }
    class NamedHost extends PewTestHost {
      override async loadDriverModule(_spec: DriverSpec) {
        return NamedDriver;
      }
    }
    const host = new NamedHost();
    cleanup.push(() => host[Symbol.dispose]());
    host.register({ name: "named", importPath: "test:named" }, null);
    const expectation = host.mint();
    await activateThroughLoad(host, expectation);

    expect(host.kernelRoot.drivers["named"]?.live).toEqual({ label: "named-driver" });
    expect(host.kernelRoot.connections[expectation.connectionId]?.live).toEqual({
      label: "named-connection",
      models: ["m"],
    });
  });

  it("two live expectations share one role:expectations lane", async () => {
    using bag = makeHost();
    const E1 = bag.host.mint();
    await activateThroughLoad(bag.host, E1);
    const E2 = bag.host.mint();
    await activateThroughLoad(bag.host, E2);
    expect({
      schema: bag.host.awareness.getSchema().filter((name) => name.startsWith("role:")),
      e1: E1.workerPresent,
      e2: E2.workerPresent,
    }).toEqual({
      schema: [ROLE_EXPECTATIONS_LANE],
      e1: true,
      e2: true,
    });
  });

  it("workerPresent follows the actor's role-lane occupancy, not a durable outcome", async () => {
    using bag = makeHost();
    const expectation = bag.host.mint();
    expect(expectation.workerPresent).toBe(false);
    await activateThroughLoad(bag.host, expectation);
    expect(expectation.workerPresent).toBe(true);
    expect(expectation.outcome).toBeNull();
    bag.loader.lastActor!.complete({ value: "ok" });
    await flushMicrotasks();
    expect(expectation.outcome).toBe("successful");
    expect(expectation.workerPresent).toBe(false);
  });
});
