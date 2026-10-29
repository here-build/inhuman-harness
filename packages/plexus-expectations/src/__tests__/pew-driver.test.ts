import { observable, runInAction, when } from "mobx";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  isDriverConnectionClass,
  PEW_DRIVER_BRAND,
  PEWDriver,
  type DriverConnectionClass,
  type DriverOffer,
} from "../driver/index.js";
import type { ExpectationActor } from "../driver/ExpectationActor.js";
import { flushMicrotasks, PewTestHost, ScriptedActor, TestExpectation } from "./_helpers/test-host.js";
import type { DriverSpec, WorkExpectation } from "../shared/index.js";

describe("isDriverConnectionClass", () => {
  it("a duplicated module graph's class (structurally identical, brand set, prototype NOT instanceof) still passes via the brand", () => {
    class ForeignDriverConnection {
      static readonly pewBrand = PEW_DRIVER_BRAND;
      constructor(public readonly spec: unknown) {}
    }
    expect(ForeignDriverConnection.prototype instanceof PEWDriver).toBe(false);
    expect(isDriverConnectionClass(ForeignDriverConnection)).toBe(true);
  });
});

describe("PEWDriver schema doors", () => {
  it("parse* runs the subclass schema without constructing; construct throws the same door", () => {
    class Gated extends PEWDriver {
      static override readonly configurationSchema = z.object({
        token: z.string({ error: "token required" }),
      });
      static override readonly secretsSchema = z.object({
        apiKey: z.string({ error: "apiKey must be a string" }),
      });
      static override readonly configurationLabel = "gated";
      async bootstrap(): Promise<void> {}
      protected resolve(): ExpectationActor<any> {
        throw new Error("not used");
      }
    }
    expect(() => Gated.parseConfiguration({})).toThrow("gated connection config invalid: token required");
    expect(Gated.parseConfiguration({ token: "x" })).toEqual({ token: "x" });
    expect(() => new Gated("row", {})).toThrow("gated connection config invalid: token required");

    expect(() => Gated.parseSecrets({ apiKey: 1 })).toThrow(
      "gated connection secrets invalid: apiKey must be a string",
    );
    const connection = new Gated("row", { token: "x" }, { apiKey: "sk" });
    expect(connection.secrets.get("apiKey")).toBe("sk");
  });
});

describe("PEWDriver instance", () => {
  it("resolveExpectation caches per expectation — resolve() runs at most once", () => {
    const host = new PewTestHost();
    let resolveCalls = 0;
    class OneShotDriver extends PEWDriver {
      async bootstrap(): Promise<void> {}
      protected resolve(expectation: WorkExpectation): ExpectationActor<any> {
        resolveCalls += 1;
        return new ScriptedActor(expectation, this);
      }
    }
    host.register({ name: "oneshot" }, null);
    const connection = new OneShotDriver("oneshot");
    const expectation = new TestExpectation({ connectionId: "oneshot" });
    host.mint(expectation);

    expect(connection.resolveExpectation(expectation)).toBe(connection.resolveExpectation(expectation));
    expect(resolveCalls).toBe(1);
    host[Symbol.dispose]();
  });

  it("release drops the table entry and occupancy", () => {
    const host = new PewTestHost();
    class OneShotDriver extends PEWDriver {
      async bootstrap(): Promise<void> {}
      protected resolve(expectation: WorkExpectation): ExpectationActor<any> {
        return new ScriptedActor(expectation, this);
      }
    }
    host.register({ name: "release" }, null);
    const connection = new OneShotDriver("release");
    const expectation = new TestExpectation({ connectionId: "release" });
    host.mint(expectation);
    connection.handle(expectation);
    expect(expectation.workerPresent).toBe(true);
    connection.release(expectation);
    expect(connection.has(expectation)).toBe(false);
    expect(expectation.workerPresent).toBe(false);
    host[Symbol.dispose]();
  });
});

describe("orchestrator-level sharing (via the ensure pipeline)", () => {
  it("class offers publish onto the catalog without a connection ensure", async () => {
    class PresenceDriver extends PEWDriver {
      static readonly offers = [
        {
          name: "Ollama",
          description: "Local OpenAI-compat :11434",
          live: true,
          adoptable: true,
          settings: { baseUrl: "http://127.0.0.1:11434/v1" },
        },
      ];
      async bootstrap(): Promise<void> {}
      protected resolve(expectation: WorkExpectation): ExpectationActor<any> {
        return new ScriptedActor(expectation, this);
      }
    }

    class PresenceHost extends PewTestHost {
      override async loadDriverModule(_spec: DriverSpec) {
        return PresenceDriver;
      }
    }
    const host = new PresenceHost();
    host.register({ name: "openai-compat", importPath: "test:openai-compat" }, null);
    await when(() => host.kernelRoot.drivers["openai-compat"]!.readyState === "ready");
    expect(host.kernelRoot.drivers["openai-compat"]!.readyState).toBe("ready");
    expect(host.kernelRoot.connections["openai-compat"]!.readyState).toBeNull();
    expect(host.kernelRoot.drivers["openai-compat"]!.offers).toEqual([
      {
        name: "Ollama",
        description: "Local OpenAI-compat :11434",
        live: true,
        adoptable: true,
        settings: { baseUrl: "http://127.0.0.1:11434/v1" },
      },
    ]);
    host[Symbol.dispose]();
  });

  it("observable class offers re-publish onto the catalog until the orchestrator disposes", async () => {
    const detected = observable.box<readonly DriverOffer[]>([], { deep: false });
    const offer = (name: string): DriverOffer => ({
      name,
      description: name,
      live: true,
      adoptable: true,
      settings: { baseUrl: `http://127.0.0.1/${name}` },
    });
    class LiveOffersDriver extends PEWDriver {
      static override get offers(): readonly DriverOffer[] {
        return detected.get();
      }
      async bootstrap(): Promise<void> {}
      protected resolve(expectation: WorkExpectation): ExpectationActor<any> {
        return new ScriptedActor(expectation, this);
      }
    }
    class LiveOffersHost extends PewTestHost {
      override async loadDriverModule(_spec: DriverSpec) {
        return LiveOffersDriver;
      }
    }
    const host = new LiveOffersHost();
    host.register({ name: "live-offers", importPath: "test:live-offers" }, null);
    await when(() => host.kernelRoot.drivers["live-offers"]!.readyState === "ready");
    const spec = host.kernelRoot.drivers["live-offers"]!;
    expect(spec.offers).toEqual([]);

    runInAction(() => detected.set([offer("a")]));
    expect(spec.offers).toEqual([offer("a")]);
    runInAction(() => detected.set([offer("a"), offer("b")]));
    expect(spec.offers).toEqual([offer("a"), offer("b")]);

    host[Symbol.dispose]();
    runInAction(() => detected.set([]));
    expect(spec.offers).toEqual([offer("a"), offer("b")]);
  });

  it("loadDriverModule returning a non-class rejects via the invariant, surfacing as a failed driver", async () => {
    class BogusHost extends PewTestHost {
      override async loadDriverModule(_spec: DriverSpec) {
        return {} as DriverConnectionClass;
      }
    }
    const host = new BogusHost();
    host.register({ name: "bogus", importPath: "test:bogus" }, null);
    const expectation = host.mint();
    const driver = host.catalogDrivers[0]!;
    await when(() => driver.readyState === "failed");
    await flushMicrotasks();
    expect(expectation.outcome).toBeNull();
    expect(driver.error).toContain("loadDriverModule: result is not a PEWDriver class");
    expect(host.catalogFaces[0]!.readyState).toBeNull();
    host[Symbol.dispose]();
  });
});
