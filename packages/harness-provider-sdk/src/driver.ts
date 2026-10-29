import { DriverSpec } from "@inhuman.tools/plexus-expectations";

import type { DriverDefinition } from "./descriptor.js";

/** Declarations fill DriverSpec inventory. Process facts stay untouched. */
export function applyDriverDefinition(spec: DriverSpec, driver: DriverDefinition): void {
  spec.name = driver.name;
  spec.description = driver.description;
  spec.importPath = driver.importPath;
  spec.abilityClaim = [...driver.abilityClaim];
  spec.multiplicity = driver.multiplicity;
}
