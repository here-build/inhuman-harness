import { when } from "mobx";
import { afterEach, describe, expect, it } from "vitest";

import {
  activateThroughLoad,
  connectAuthor,
  flushMicrotasks,
  makeHost,
  PewTestHost,
  ScriptedActor,
} from "./_helpers/test-host.js";
import { PEWDriver } from "../driver/index.js";
import { Orchestrator } from "../executor/orchestrator.js";
import { revalidationDemandOf, publishRevalidationDemand, publishRevalidationDemandFocus } from "../shared/revalidation-demand.js";
import type { DriverSpec, WorkExpectation } from "../shared/index.js";

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup) fn();
  cleanup = [];
});

describe("attention occupancy reduce", () => {
  it("focus wins over ambient; retracting focus leaves ambient, then none", () => {
    using bag = makeHost();
    const hub = bag.host.kernel.awareness;
    const target = { kind: "connection", id: "test" } as const;
    expect(revalidationDemandOf(hub, target)).toBe("none");

    const list = connectAuthor(hub);
    const sheet = connectAuthor(hub);
    cleanup.push(
      () => list[Symbol.dispose](),
      () => sheet[Symbol.dispose](),
    );
    publishRevalidationDemand(list.author, [target]);
    list.sync();
    expect(revalidationDemandOf(hub, target)).toBe("secondary");
    expect(revalidationDemandOf(hub, { kind: "connection", id: "other" })).toBe("none");

    publishRevalidationDemandFocus(sheet.author, target);
    sheet.sync();
    expect(revalidationDemandOf(hub, target)).toBe("primary");

    publishRevalidationDemandFocus(sheet.author, null);
    sheet.sync();
    expect(revalidationDemandOf(hub, target)).toBe("secondary");
    publishRevalidationDemand(list.author, []);
    list.sync();
    expect(revalidationDemandOf(hub, target)).toBe("none");
  });
});

describe("PEWDriver attention", () => {
  it("instance attention tracks connection occupancy", async () => {
    using bag = makeHost();
    const expectation = bag.host.mint();
    await activateThroughLoad(bag.host, expectation);
    const instance = await bag.host.ensure("test");
    expect(instance.revalidationDemand).toBe("none");
    expect(instance.awareness).toBe(bag.host.kernel.awareness);

    const peer = connectAuthor(bag.host.kernel.awareness);
    cleanup.push(() => peer[Symbol.dispose]());
    publishRevalidationDemand(peer.author, [{ kind: "connection", id: "test" }]);
    peer.sync();
    await flushMicrotasks();
    expect(instance.revalidationDemand).toBe("secondary");

    publishRevalidationDemandFocus(peer.author, { kind: "connection", id: "test" });
    peer.sync();
    await flushMicrotasks();
    expect(instance.revalidationDemand).toBe("primary");
  });

  it("class attention tracks driver occupancy without a connection row", async () => {
    class PresenceDriver extends PEWDriver {
      async bootstrap(): Promise<void> {}
      protected resolve(expectation: WorkExpectation): ScriptedActor {
        return new ScriptedActor(expectation, this);
      }
    }
    class PresenceHost extends PewTestHost {
      override async loadDriverModule(_spec: DriverSpec) {
        return PresenceDriver;
      }
    }
    const host = new PresenceHost();
    cleanup.push(() => host[Symbol.dispose]());
    host.register({ name: "listed", importPath: "test:listed" }, null);
    await when(() => host.kernelRoot.drivers["listed"]!.readyState === "ready");
    expect(PresenceDriver.revalidationDemand).toBe("none");
    expect(PresenceDriver.awareness).toBe(host.kernel.awareness);

    const peer = connectAuthor(host.kernel.awareness);
    cleanup.push(() => peer[Symbol.dispose]());
    publishRevalidationDemand(peer.author, [{ kind: "driver", name: "listed" }]);
    peer.sync();
    await flushMicrotasks();
    expect(PresenceDriver.revalidationDemand).toBe("secondary");

    publishRevalidationDemandFocus(peer.author, { kind: "driver", name: "listed" });
    peer.sync();
    await flushMicrotasks();
    expect(PresenceDriver.revalidationDemand).toBe("primary");
  });

  it("session awareness does not activate connection occupancy", async () => {
    using bag = makeHost();
    const instance = await bag.host.ensure("test");
    const target = { kind: "connection", id: "test" } as const;
    const sessionPeer = connectAuthor(bag.host.awareness);
    cleanup.push(() => sessionPeer[Symbol.dispose]());
    publishRevalidationDemand(sessionPeer.author, [target]);
    publishRevalidationDemandFocus(sessionPeer.author, target);
    sessionPeer.sync();
    await flushMicrotasks();
    expect(instance.revalidationDemand).toBe("none");
    expect(instance.awareness).toBe(bag.host.kernel.awareness);
    expect(revalidationDemandOf(bag.host.session.awareness, target)).toBe("primary");
    expect(revalidationDemandOf(bag.host.kernel.awareness, target)).toBe("none");
  });

  it("shared intern keeps kernel occupancy across session park", async () => {
    using bag = makeHost();
    const first = bag.host;
    const expectation = first.mint();
    await activateThroughLoad(first, expectation);
    const instance = await first.ensure("test");
    const focused = connectAuthor(first.kernel.awareness);
    cleanup.push(() => focused[Symbol.dispose]());
    publishRevalidationDemand(focused.author, [{ kind: "connection", id: "test" }]);
    publishRevalidationDemandFocus(focused.author, { kind: "connection", id: "test" });
    focused.sync();
    await flushMicrotasks();
    expect(instance.revalidationDemand).toBe("primary");

    const second = first.forkSession();
    cleanup.push(() => second[Symbol.dispose]());
    // Helper owns the kernel: park the orchestrator only, do not destroy the interned hub.
    Orchestrator.prototype[Symbol.dispose].call(first);
    expect(instance.revalidationDemand).toBe("primary");
    expect(instance.awareness).toBe(first.kernel.awareness);

    const reused = await second.ensure("test");
    expect(reused).toBe(instance);
    expect(reused.awareness).toBe(second.kernel.awareness);
    expect(reused.revalidationDemand).toBe("primary");
    expect(revalidationDemandOf(first.session.awareness, { kind: "connection", id: "test" })).toBe("none");
  });

  it("two independent kernel authors: one retracts while the other remains, then none", async () => {
    using bag = makeHost();
    const instance = await bag.host.ensure("test");
    const target = { kind: "connection", id: "test" } as const;
    const firstAuthor = connectAuthor(bag.host.kernel.awareness);
    const secondAuthor = connectAuthor(bag.host.kernel.awareness);
    cleanup.push(
      () => firstAuthor[Symbol.dispose](),
      () => secondAuthor[Symbol.dispose](),
    );
    publishRevalidationDemandFocus(firstAuthor.author, target);
    firstAuthor.sync();
    publishRevalidationDemandFocus(secondAuthor.author, target);
    secondAuthor.sync();
    await flushMicrotasks();
    expect(instance.revalidationDemand).toBe("primary");

    publishRevalidationDemandFocus(firstAuthor.author, null);
    firstAuthor.sync();
    await flushMicrotasks();
    expect(instance.revalidationDemand).toBe("primary");

    publishRevalidationDemandFocus(secondAuthor.author, null);
    secondAuthor.sync();
    await flushMicrotasks();
    expect(instance.revalidationDemand).toBe("none");
  });

  it("simultaneous clients union: focus from one, ambient from another", async () => {
    using bag = makeHost();
    const instance = await bag.host.ensure("test");
    const list = connectAuthor(bag.host.kernel.awareness);
    const sheet = connectAuthor(bag.host.kernel.awareness);
    cleanup.push(
      () => list[Symbol.dispose](),
      () => sheet[Symbol.dispose](),
    );
    publishRevalidationDemand(list.author, [{ kind: "connection", id: "test" }]);
    list.sync();
    publishRevalidationDemandFocus(sheet.author, { kind: "connection", id: "test" });
    sheet.sync();
    await flushMicrotasks();
    expect(instance.revalidationDemand).toBe("primary");

    publishRevalidationDemandFocus(sheet.author, null);
    sheet.sync();
    await flushMicrotasks();
    expect(instance.revalidationDemand).toBe("secondary");
  });
});
