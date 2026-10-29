/**
 * One driver-class resolver for adopt, discovery, and execution.
 * Registered classes win; unregistered importPath uses the injected loader.
 */
import { fail, step } from "@inhuman.tools/harness-diagnostics";
import { isDriverConnectionClass, type DriverConnectionClass } from "@inhuman.tools/plexus-expectations/driver";

export type ResolvePurpose = "adopt" | "discovery" | "execution";

export type ExternalDriverLoader = (importPath: string) => Promise<unknown>;

export type ResolveOptions = {
  readonly purpose?: ResolvePurpose;
  readonly loadExternal?: ExternalDriverLoader;
};

export type DriverResolveSpec = {
  readonly name: string;
  readonly importPath: string;
  readonly abilityClaim?: readonly string[];
  readonly multiplicity?: string;
};

function resolveFailed(purpose: ResolvePurpose | undefined, importPath: string, error: unknown): never {
  const detail = error instanceof Error ? error.message : String(error);
  switch (purpose) {
    case "adopt": {
      fail("connect/adopt resolve", error);
      throw new Error(`connect/adopt: ${importPath}: ${detail}`);
    }
    case "discovery": {
      fail("connect/models resolve", error);
      throw new Error(`connect/models: ${importPath}: ${detail}`);
    }
    case "execution": {
      fail("loadDriverModule resolve", error);
      throw new Error(`loadDriverModule: ${importPath}: ${detail}`);
    }
    default: {
      throw new Error(`connections: ${importPath}: ${detail}`);
    }
  }
}

function notADriver(purpose: ResolvePurpose | undefined, importPath: string): never {
  switch (purpose) {
    case "adopt": {
      throw new Error(`connect/adopt: not a driver: ${importPath}`);
    }
    case "discovery": {
      fail(`connect/models not_a_driver ${importPath}`);
      throw new Error(`connect/models: not_a_driver:${importPath}`);
    }
    case "execution": {
      fail(`loadDriverModule not_a_driver ${importPath}`);
      throw new Error(`loadDriverModule: not_a_driver:${importPath}`);
    }
    default: {
      throw new Error(`connections: not_a_driver:${importPath}`);
    }
  }
}

export async function loadUnresolvedDriverClass(
  importPath: string,
  options: ResolveOptions = {},
): Promise<DriverConnectionClass> {
  const load = options.loadExternal;
  if (load == null) {
    throw new Error(`connections: unknown driver import ${importPath}`);
  }
  if (options.purpose === "discovery") {
    step(`connect/models load ${importPath}`);
  } else if (options.purpose === "execution") {
    step(`loadDriverModule ${importPath}`);
  }
  let exported: unknown;
  try {
    exported = await load(importPath);
  } catch (error) {
    resolveFailed(options.purpose, importPath, error);
  }
  if (!isDriverConnectionClass(exported)) notADriver(options.purpose, importPath);
  return exported;
}

export function descriptorsMatch(spec: DriverResolveSpec, registered: DriverResolveSpec): boolean {
  if (spec.name !== registered.name) return false;
  if (spec.importPath.trim() !== "" && spec.importPath !== registered.importPath) {
    return false;
  }
  if (spec.multiplicity != null && spec.multiplicity !== registered.multiplicity) {
    return false;
  }
  if (spec.abilityClaim == null || spec.abilityClaim.length === 0) return true;
  if (spec.abilityClaim.length !== registered.abilityClaim?.length) return false;
  const allowed = new Set(registered.abilityClaim);
  return spec.abilityClaim.every((token) => allowed.has(token));
}

export function incompatibleDescriptor(name: string): Error {
  return new Error(`connections: driver "${name}" descriptor is incompatible`);
}
