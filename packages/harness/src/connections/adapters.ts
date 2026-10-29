/**
 * Adapters for connect/adopt, connect/models discovery, and session
 * loadDriverModule. Vendors stay in the product roster. This file maps
 * the Node import() door onto {@link DriverRegistry}.
 */
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { applyDriverDefinition } from "@inhuman.tools/harness-provider-sdk";
import { DriverSpec } from "@inhuman.tools/plexus-expectations";
import type {
  ConnectionSecretsView,
  DriverConnectionClass,
  PEWDriver,
} from "@inhuman.tools/plexus-expectations/driver";

import { adoptDriver, type AdoptCallback, type DriverAdoptArgs, type DriverAdoptBags } from "./adopt.js";
import { type CredentialsStore, secretsView } from "./credentials.js";
import { ensureRegisteredConnection, type InternKernel } from "./intern.js";
import type { DriverRegistry } from "./registry.js";
import type { ResolveOptions } from "./resolve.js";

export type DriverInventory = {
  readonly [name: string]: { readonly importPath: string } | undefined;
};

export function applyRegistryToDrivers(
  registry: DriverRegistry,
  drivers: Record<string, DriverSpec | undefined>,
): void {
  for (const driver of registry.list()) {
    const spec = drivers[driver.name] ?? new DriverSpec();
    applyDriverDefinition(spec, driver);
    drivers[driver.name] = spec;
  }
}

export function loadExternalDriver(importPath: string, moduleRoot: string): Promise<unknown> {
  const parent = join(moduleRoot, "package.json");
  const url = pathToFileURL(createRequire(parent).resolve(importPath)).href;
  return import(url).then((mod: { default?: unknown }) => mod.default);
}

export function externalLoaderFor(moduleRoot: string): (importPath: string) => Promise<unknown> {
  return (importPath) => loadExternalDriver(importPath, moduleRoot);
}

export function allocateConnectionId(used: ReadonlySet<string>, name: string): string {
  const base = slug(name, "connection");
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

function slug(name: string, fallback: string): string {
  const s = name
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
  return s.length > 0 ? s : fallback;
}

/** `connect/adopt` driver-class door. */
export async function resolveAdoptClass(
  registry: DriverRegistry,
  driverName: string,
  inventory: DriverInventory,
  options: ResolveOptions = {},
): Promise<DriverConnectionClass> {
  const spec = inventory[driverName];
  if (spec === undefined || spec.importPath.trim() === "") {
    throw new Error(`connect/adopt: unknown driver ${driverName}`);
  }
  return registry.resolve({ name: driverName, importPath: spec.importPath }, { ...options, purpose: "adopt" });
}

/** `connect/adopt` after the class is resolved. */
export async function adoptRegisteredDriver(
  registry: DriverRegistry,
  driverName: string,
  inventory: DriverInventory,
  args: DriverAdoptArgs,
  callback: AdoptCallback,
  options: ResolveOptions = {},
): Promise<DriverAdoptBags> {
  const connectionClass = await resolveAdoptClass(registry, driverName, inventory, options);
  return adoptDriver(connectionClass, args, callback);
}

/** Session `loadDriverModule`. */
export async function loadDriverModule(
  registry: DriverRegistry,
  driver: { readonly name: string; readonly importPath: string },
  options: ResolveOptions = {},
): Promise<DriverConnectionClass> {
  return registry.resolve(driver, { ...options, purpose: "execution" });
}

/** `probeCompletionCatalog` intern-probe. Shares PEW intern with session ensure. */
export async function internForDiscovery(
  registry: DriverRegistry,
  kernel: InternKernel,
  owner: object,
  connectionId: string,
  options: {
    readonly secrets: CredentialsStore | ConnectionSecretsView;
    readonly awareness?: PEWDriver["awareness"];
    readonly loadExternal?: ResolveOptions["loadExternal"];
  },
): Promise<PEWDriver> {
  const spec = kernel.connections[connectionId];
  if (spec === undefined) {
    throw new Error(`unknown connection ${connectionId}`);
  }
  return ensureRegisteredConnection(registry, kernel, owner, connectionId, {
    purpose: "discovery",
    secrets: isCredentialsStore(options.secrets) ? secretsView(options.secrets, connectionId) : options.secrets,
    awareness: options.awareness,
    loadExternal: options.loadExternal,
  });
}

/** Session ensure over the same intern as discovery. */
export async function internForExecution(
  registry: DriverRegistry,
  kernel: InternKernel,
  owner: object,
  connectionId: string,
  options: {
    readonly secrets: CredentialsStore | ConnectionSecretsView;
    readonly awareness?: PEWDriver["awareness"];
    readonly loadExternal?: ResolveOptions["loadExternal"];
  },
): Promise<PEWDriver> {
  return ensureRegisteredConnection(registry, kernel, owner, connectionId, {
    purpose: "execution",
    secrets: isCredentialsStore(options.secrets) ? secretsView(options.secrets, connectionId) : options.secrets,
    awareness: options.awareness,
    loadExternal: options.loadExternal,
  });
}

export function completionConnectionIds(connections: InternKernel["connections"], id?: string): string[] {
  if (id != null) {
    const spec = connections[id];
    if (spec === undefined) throw new Error(`unknown connection ${id}`);
    if (!spec.driver.abilityClaim.includes("completion")) {
      throw new Error(`${id} is not a completion connection`);
    }
    if (spec.configuration.enabled === false) {
      throw new Error(`connection ${id} is disabled`);
    }
    return [id];
  }
  return Object.keys(connections)
    .filter((key) => {
      const spec = connections[key];
      return spec != null && spec.driver.abilityClaim.includes("completion") && spec.configuration.enabled !== false;
    })
    .sort();
}

function isCredentialsStore(value: CredentialsStore | { get(field: string): unknown }): value is CredentialsStore {
  return typeof (value as CredentialsStore).read === "function";
}
