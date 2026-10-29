/**
 * Shared connection lifecycle over the existing PEW intern.
 * Do not add a second process-local connection table here.
 */
import type { ConnectionSpec } from "@inhuman.tools/plexus-expectations";
import type { ConnectionSecretsView, PEWDriver } from "@inhuman.tools/plexus-expectations/driver";
import { acquireConnection } from "@inhuman.tools/plexus-expectations/executor";
import { action } from "mobx";

import type { DriverRegistry } from "./registry.js";
import type { ResolveOptions } from "./resolve.js";

export type InternKernel = {
  readonly connections: Record<string, ConnectionSpec | undefined>;
};

export type InternOptions = ResolveOptions & {
  readonly secrets: ConnectionSecretsView;
  readonly awareness?: PEWDriver["awareness"];
};

export function requireFreeConnectionId(kernel: InternKernel, id: string): void {
  if (kernel.connections[id] !== undefined) {
    throw new Error(`connections: connection "${id}" collides`);
  }
}

export async function ensureRegisteredConnection(
  registry: DriverRegistry,
  kernel: InternKernel,
  owner: object,
  connectionId: string,
  options: InternOptions,
): Promise<PEWDriver> {
  const spec = kernel.connections[connectionId];
  if (spec === undefined) {
    throw new Error(`connections: unknown connection ${connectionId}`);
  }
  const instance = await acquireConnection(kernel, owner, connectionId, async () => {
    const connectionClass = await registry.resolve(spec.driver, options);
    const minted = new connectionClass(connectionId, spec.configuration, options.secrets);
    bindAwareness(minted, options.awareness);
    return minted;
  });
  bindAwareness(instance, options.awareness);
  await instance.ensureBootstrapStarted();
  return instance;
}

function bindAwareness(instance: PEWDriver, awareness: PEWDriver["awareness"]): void {
  if (awareness === undefined) return;
  action(() => {
    instance.awareness = awareness;
  })();
}
