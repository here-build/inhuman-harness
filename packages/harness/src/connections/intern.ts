/**
 * Shared connection lifecycle over the existing expectation intern.
 * Do not add a second process-local connection table here.
 */
import type { ConnectionSpec } from "@inhuman.tools/expectations";
import type { ConnectionSecretsView, ExpectationDriver } from "@inhuman.tools/expectations/driver";
import { acquireConnection } from "@inhuman.tools/expectations/executor";
import { action } from "mobx";

import type { DriverRegistry } from "./registry.js";
import type { ResolveOptions } from "./resolve.js";

export type InternKernel = {
  readonly connections: Record<string, ConnectionSpec | undefined>;
};

export type InternOptions = ResolveOptions & {
  readonly secrets: ConnectionSecretsView;
  readonly awareness?: ExpectationDriver["awareness"];
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
): Promise<ExpectationDriver> {
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

function bindAwareness(instance: ExpectationDriver, awareness: ExpectationDriver["awareness"]): void {
  if (awareness === undefined) return;
  action(() => {
    instance.awareness = awareness;
  })();
}
