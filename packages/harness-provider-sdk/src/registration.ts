import type { DriverConnectionClass } from "@inhuman.tools/plexus-expectations/driver";

import type { CapabilityKind } from "./capabilities.js";
import { type DriverDefinition } from "./descriptor.js";
import { providerBrand, type ProviderSdkContract } from "./identity.js";
import { parseWith } from "./parse.js";
import { PROVIDER_SDK_CONTRACT } from "./schemas/index.js";
import { providerRegistrationSchema } from "./schemas/provider.js";

export type RegisteredDriver = DriverDefinition & {
  readonly [providerBrand.driver]: true;
  readonly providerId: string;
  readonly connection: DriverConnectionClass;
};

export type RegisteredProvider = {
  readonly [providerBrand.registration]: true;
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly contract: ProviderSdkContract;
  readonly drivers: readonly RegisteredDriver[];
};

function freezeRegisteredDriver(
  providerId: string,
  row: {
    name: string;
    description: string;
    abilityClaim: readonly CapabilityKind[];
    multiplicity: DriverDefinition["multiplicity"];
    importPath?: string;
    connection: DriverConnectionClass;
  },
): RegisteredDriver {
  return Object.freeze({
    [providerBrand.driver]: true as const,
    providerId,
    name: row.name,
    description: row.description,
    abilityClaim: Object.freeze([...row.abilityClaim]),
    multiplicity: row.multiplicity,
    importPath: row.importPath ?? row.name,
    connection: row.connection,
  });
}

function rejectDuplicateDrivers(drivers: readonly { name: string }[], context: string): void {
  const seen = new Set<string>();
  for (const driver of drivers) {
    if (seen.has(driver.name)) throw new Error(`${context}: driver "${driver.name}" collides`);
    seen.add(driver.name);
  }
}

export function parseProviderRegistration(value: unknown): RegisteredProvider {
  const parsed = parseWith(providerRegistrationSchema, value);
  rejectDuplicateDrivers(parsed.drivers, "provider-sdk");
  return Object.freeze({
    [providerBrand.registration]: true as const,
    id: parsed.id,
    name: parsed.name,
    description: parsed.description ?? "",
    contract: PROVIDER_SDK_CONTRACT,
    drivers: Object.freeze(parsed.drivers.map((row) => freezeRegisteredDriver(parsed.id, row))),
  });
}

/**
 * Compose a roster. Duplicate provider ids or driver names fail before any
 * connection is constructed — identity is catalog keys, not intern slots.
 */
export function registerProviders(inputs: readonly unknown[]): RegisteredProvider[] {
  const providers = inputs.map((input) => parseProviderRegistration(input));
  const providerIds = new Set<string>();
  const driverNames = new Set<string>();
  for (const provider of providers) {
    if (providerIds.has(provider.id)) {
      throw new Error(`provider-sdk: provider "${provider.id}" collides`);
    }
    providerIds.add(provider.id);
    for (const driver of provider.drivers) {
      if (driverNames.has(driver.name)) {
        throw new Error(`provider-sdk: driver "${driver.name}" collides`);
      }
      driverNames.add(driver.name);
    }
  }
  return providers;
}

export function flattenDrivers(providers: readonly RegisteredProvider[]): readonly RegisteredDriver[] {
  return providers.flatMap((provider) => provider.drivers);
}

export function isRegisteredProvider(value: unknown): value is RegisteredProvider {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { [k: symbol]: unknown })[providerBrand.registration] === true
  );
}

export function isRegisteredDriver(value: unknown): value is RegisteredDriver {
  return (
    typeof value === "object" && value !== null && (value as { [k: symbol]: unknown })[providerBrand.driver] === true
  );
}
