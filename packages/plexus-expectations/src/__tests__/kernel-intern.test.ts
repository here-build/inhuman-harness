import { observable } from "mobx";
import { describe, expect, it } from "vitest";

import { ConnectionMiss } from "../driver/connection-miss.js";
import { ExpectationActor } from "../driver/ExpectationActor.js";
import { PEWDriver } from "../driver/PEWDriver.js";
import { dropConnection } from "../executor/kernel-intern.js";
import { makeHost, PewTestHost, TestExpectation } from "./_helpers/test-host.js";
import { DriverSpec } from "../shared/models/DriverSpec.js";

describe("kernel connection intern", () => {
  it("dropConnection remints; two orchestrators both forget the sticky memo", async () => {
    const bag = makeHost();
    try {
      const first = await bag.host.ensure(bag.connectionId);
      const other = bag.host.forkSession();
      const second = await other.ensure(bag.connectionId);
      expect(second).toBe(first);
      bag.loader.failLoad = new Error("handshake");
      await dropConnection(bag.host.kernel.root, bag.connectionId);
      bag.loader.failLoad = null;
      const reminted = await bag.host.ensure(bag.connectionId);
      const remintedOther = await other.ensure(bag.connectionId);
      expect({
        sameAsFirst: reminted === first,
        shared: remintedOther === reminted,
        ready: reminted.readyState,
      }).toEqual({
        sameAsFirst: false,
        shared: true,
        ready: "ready",
      });
      other[Symbol.dispose]();
    } finally {
      bag[Symbol.dispose]();
    }
  });

  it("failed handshake stays sticky until dropConnection", async () => {
    const bag = makeHost();
    try {
      bag.loader.failLoad = new Error("handshake");
      await bag.host.ensure(bag.connectionId).catch(() => {});
      bag.loader.failLoad = null;
      await expect(bag.host.ensure(bag.connectionId)).rejects.toThrow("handshake");
      await dropConnection(bag.host.kernel.root, bag.connectionId);
      const reminted = await bag.host.ensure(bag.connectionId);
      expect(reminted.readyState).toBe("ready");
    } finally {
      bag[Symbol.dispose]();
    }
  });

  it("a dropped pending lease rejects its old owner and cannot mirror over or evict its replacement", async () => {
    const loading = Promise.withResolvers<void>();
    const disposal = Promise.withResolvers<void>();
    const instances: Pin[] = [];
    const disposed: number[] = [];
    class Pin extends PEWDriver {
      readonly generation = instances.push(this);
      override accessor state = observable({ generation: this.generation });
      async bootstrap(): Promise<void> {}
      protected resolve(): ExpectationActor<never> {
        throw new Error("unused");
      }
      override async [Symbol.asyncDispose](): Promise<void> {
        disposed.push(this.generation);
        if (this.generation === 1) await disposal.promise;
      }
    }
    class Host extends PewTestHost {
      override async loadDriverModule(_spec: DriverSpec) {
        await loading.promise;
        return Pin;
      }
    }
    const host = new Host();
    try {
      host.register("row", null);
      const old = host.ensure("row").then(
        () => ({ outcome: "resolved" }),
        (error: unknown) => ({
          outcome: "rejected",
          code: error instanceof ConnectionMiss ? error.code : String(error),
        }),
      );
      const dropped = dropConnection(host.kernel.root, "row");
      const next = host.ensure("row");
      loading.resolve();
      const replacement = await next;
      expect({
        old: await old,
        generation: replacement.state.generation,
        disposed: [...disposed],
        face: host.connections.row?.live,
      }).toEqual({
        old: { outcome: "rejected", code: "connection-dropped" },
        generation: 2,
        disposed: [1],
        face: { generation: 2 },
      });
      disposal.resolve();
      await dropped;
      instances[0]!.failReady(new Error("late old handle failure"));
      const kept = await host.ensure("row");
      expect({
        same: kept === replacement,
        attached: host.connectionOf(new TestExpectation({ connectionId: "row" })) === replacement,
        face: host.connections.row?.live,
        error: host.connections.row?.error,
        disposed: [...disposed],
      }).toEqual({ same: true, attached: true, face: { generation: 2 }, error: "", disposed: [1] });
    } finally {
      loading.resolve();
      disposal.resolve();
      await dropConnection(host.kernel.root, "row");
      host[Symbol.dispose]();
    }
  });

  it("dropConnection aborts interned actors with connection-dropped", async () => {
    class Watched extends PEWDriver {
      reasons: unknown[] = [];
      disposed = 0;
      async bootstrap(): Promise<void> {}
      protected resolve(): ExpectationActor<never> {
        throw new Error("unused");
      }
      override abortOnDrop(reason: unknown): void {
        this.reasons.push(reason);
        super.abortOnDrop(reason);
      }
      override async [Symbol.asyncDispose](): Promise<void> {
        this.disposed += 1;
      }
    }
    class Host extends PewTestHost {
      override async loadDriverModule(_spec: DriverSpec) {
        return Watched;
      }
    }
    const host = new Host();
    try {
      host.register("row", null);
      const instance = (await host.ensure("row")) as Watched;
      await dropConnection(host.kernel.root, "row");
      expect({
        miss: instance.reasons[0],
        disposed: instance.disposed,
      }).toEqual({
        miss: expect.objectContaining({
          name: "ConnectionMiss",
          code: "connection-dropped",
        } satisfies Partial<ConnectionMiss>),
        disposed: 1,
      });
    } finally {
      host[Symbol.dispose]();
    }
  });
});
