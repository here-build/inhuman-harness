import type { DriverMultiplicity } from "@inhuman.tools/plexus-expectations";

import type { CapabilityKind } from "./capabilities.js";
import { providerBrand, type ProviderSdkContract } from "./identity.js";
import { parseWith } from "./parse.js";
import { PROVIDER_SDK_CONTRACT } from "./schemas/index.js";
import { providerDescriptorSchema } from "./schemas/provider.js";

export type DriverDefinition = {
  readonly name: string;
  readonly description: string;
  readonly abilityClaim: readonly CapabilityKind[];
  readonly multiplicity: DriverMultiplicity;
  readonly importPath: string;
};

export type ProviderDescriptor = {
  readonly [providerBrand.descriptor]: true;
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly contract: ProviderSdkContract;
  readonly drivers: readonly DriverDefinition[];
};

function freezeDriver(row: {
  name: string;
  description: string;
  abilityClaim: CapabilityKind[];
  multiplicity: DriverMultiplicity;
  importPath?: string;
}): DriverDefinition {
  return Object.freeze({
    name: row.name,
    description: row.description,
    abilityClaim: Object.freeze([...row.abilityClaim]),
    multiplicity: row.multiplicity,
    importPath: row.importPath ?? row.name,
  });
}

function rejectDuplicateDrivers(drivers: readonly { name: string }[], context: string): void {
  const seen = new Set<string>();
  for (const driver of drivers) {
    if (seen.has(driver.name)) throw new Error(`${context}: driver "${driver.name}" collides`);
    seen.add(driver.name);
  }
}

export function parseProviderDescriptor(value: unknown): ProviderDescriptor {
  const parsed = parseWith(providerDescriptorSchema, value);
  rejectDuplicateDrivers(parsed.drivers, "provider-sdk");
  return Object.freeze({
    [providerBrand.descriptor]: true as const,
    id: parsed.id,
    name: parsed.name,
    description: parsed.description ?? "",
    contract: PROVIDER_SDK_CONTRACT,
    drivers: Object.freeze(parsed.drivers.map(freezeDriver)),
  });
}

export function isProviderDescriptor(value: unknown): value is ProviderDescriptor {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { [k: symbol]: unknown })[providerBrand.descriptor] === true
  );
}
