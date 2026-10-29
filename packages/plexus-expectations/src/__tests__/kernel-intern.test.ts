import { describe, expect, it } from "vitest";

import { ConnectionMiss } from "../driver/connection-miss.js";
import { ExpectationActor } from "../driver/ExpectationActor.js";
import { PEWDriver } from "../driver/PEWDriver.js";
import { dropConnection } from "../executor/kernel-intern.js";
import { makeHost, PewTestHost } from "./_helpers/test-host.js";
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
      expect({ sameAsFirst: reminted === first, shared: remintedOther === reminted, ready: reminted.readyState }).toEqual({
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

  it("dropConnection during pending construct still asyncDisposes; next ensure remints", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let disposed = 0;
    class Pin extends PEWDriver {
      async bootstrap(): Promise<void> {}
      protected resolve(): ExpectationActor<never> {
        throw new Error("unused");
      }
      override async [Symbol.asyncDispose](): Promise<void> {
        disposed += 1;
      }
    }
    class Host extends PewTestHost {
      override async loadDriverModule(_spec: DriverSpec) {
        await gate;
        return Pin;
      }
    }
    const host = new Host();
    try {
      host.register("row", null);
      const pending = host.ensure("row");
      const dropped = dropConnection(host.kernel.root, "row");
      release();
      const first = await pending;
      await dropped;
      const reminted = await host.ensure("row");
      expect({ disposed, reminted: reminted === first }).toEqual({ disposed: 1, reminted: false });
    } finally {
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
        miss: expect.objectContaining({ name: "ConnectionMiss", code: "connection-dropped" } satisfies Partial<ConnectionMiss>),
        disposed: 1,
      });
    } finally {
      host[Symbol.dispose]();
    }
  });
});
