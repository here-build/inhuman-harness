/**
 * Registered driver classes for adopt, discovery, and execution.
 * Duplicate names fail here — before intern or bootstrap.
 */
import { flattenDrivers, type RegisteredDriver, type RegisteredProvider } from "@inhuman.tools/harness-provider-sdk";
import type { DriverConnectionClass } from "@inhuman.tools/plexus-expectations/driver";

import { connectionsBrand } from "./identity.js";
import {
  descriptorsMatch,
  incompatibleDescriptor,
  loadUnresolvedDriverClass,
  type DriverResolveSpec,
  type ResolveOptions,
} from "./resolve.js";

export class DriverRegistry {
  readonly [connectionsBrand.registry] = true as const;
  readonly #drivers: ReadonlyMap<string, RegisteredDriver>;

  private constructor(drivers: readonly RegisteredDriver[]) {
    const map = new Map<string, RegisteredDriver>();
    for (const driver of drivers) {
      const existing = map.get(driver.name);
      if (existing !== undefined) {
        throw new Error(`connections: driver "${driver.name}" collides`);
      }
      map.set(driver.name, driver);
    }
    this.#drivers = map;
  }

  static fromDrivers(drivers: readonly RegisteredDriver[]): DriverRegistry {
    return new DriverRegistry(drivers);
  }

  get(name: string): RegisteredDriver | undefined {
    return this.#drivers.get(name);
  }

  require(name: string): RegisteredDriver {
    const driver = this.#drivers.get(name);
    if (driver === undefined) {
      throw new Error(`connections: unknown driver ${name}`);
    }
    return driver;
  }

  list(): readonly RegisteredDriver[] {
    return [...this.#drivers.values()];
  }

  connectionClass(name: string): DriverConnectionClass {
    return this.require(name).connection;
  }

  async resolve(spec: DriverResolveSpec, options: ResolveOptions = {}): Promise<DriverConnectionClass> {
    const registered = this.#drivers.get(spec.name);
    if (registered !== undefined) {
      if (
        !descriptorsMatch(spec, {
          name: registered.name,
          importPath: registered.importPath,
          abilityClaim: registered.abilityClaim,
          multiplicity: registered.multiplicity,
        })
      ) {
        throw incompatibleDescriptor(spec.name);
      }
      return registered.connection;
    }
    const importPath = spec.importPath.trim();
    if (importPath === "") {
      throw new Error(`connections: unknown driver ${spec.name}`);
    }
    return loadUnresolvedDriverClass(importPath, options);
  }
}

export function openDriverRegistry(providers: readonly RegisteredProvider[]): DriverRegistry {
  return DriverRegistry.fromDrivers(flattenDrivers(providers));
}

export function isDriverRegistry(value: unknown): value is DriverRegistry {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { [k: symbol]: unknown })[connectionsBrand.registry] === true
  );
}
