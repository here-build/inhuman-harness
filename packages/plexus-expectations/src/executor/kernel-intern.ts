/**
 * Process-local connection intern table keyed by the kernel root object.
 *
 * Session wrap is Yjs load. Park drops an owner ref and must not dispose the
 * instance — {@link disposeKernelConnections} is kernel teardown only.
 * Rejected: last-ref dispose. Switching seats reminted every driver.
 */
import { DefaultedWeakMap } from "@here.build/collections";
import { comparer, reaction, type IReactionDisposer } from "mobx";

import { ConnectionMiss } from "../driver/connection-miss.js";
import { extraLiveFromState, type PEWDriver } from "../driver/PEWDriver.js";
import type { ConnectionSpec } from "../shared/models/ConnectionSpec.js";
import { asReadyState } from "../shared/types.js";

type InternOwner = { forgetConnection(id: string): void };

function internOwnerOf(owner: object): InternOwner | undefined {
  return typeof (owner as InternOwner).forgetConnection === "function" ? (owner as InternOwner) : undefined;
}

type KernelRoot = { readonly connections: Record<string, ConnectionSpec | undefined> };
type ConnectionHold = {
  readonly refs: Set<object>;
  readonly pending: Promise<PEWDriver>;
  mirror: IReactionDisposer | undefined;
};
type KernelIntern = { readonly connections: Map<string, ConnectionHold> };

const internByKernel = new DefaultedWeakMap<object, KernelIntern>(() => ({ connections: new Map() }));

export function acquireConnection(
  kernel: KernelRoot,
  owner: object,
  connectionId: string,
  construct: () => PEWDriver | Promise<PEWDriver>,
): Promise<PEWDriver> {
  const bag = internByKernel.get(kernel);
  const existing = bag.connections.get(connectionId);
  if (existing !== undefined) {
    existing.refs.add(owner);
    return existing.pending;
  }
  const lease: ConnectionHold = {
    refs: new Set([owner]),
    pending: Promise.resolve().then(construct).then((instance) => {
      lease.mirror = reaction(
        () => {
          const spec = kernel.connections[connectionId];
          if (spec === undefined) return null;
          const ready = asReadyState(instance.readyState);
          // Bootstrapping remint must not wipe a ready catalog.
          if (ready !== "ready" && ready !== "failed" && spec.readyState === "ready") return null;
          return { ready, error: instance.error, live: extraLiveFromState(instance.state) };
        },
        (snap) => {
          if (snap == null) return;
          kernel.connections[connectionId]?.stampProcess({
            readyState: snap.ready,
            error: snap.error,
            live: snap.live,
          });
        },
        { fireImmediately: true, equals: comparer.structural },
      );
      return instance;
    }),
    mirror: undefined,
  };
  bag.connections.set(connectionId, lease);
  void lease.pending.then(undefined, () => {
    if (lease.refs.size === 0) bag.connections.delete(connectionId);
  });
  return lease.pending;
}

export function releaseConnection(kernel: object, owner: object, connectionId: string): void {
  if (!internByKernel.has(kernel)) return;
  internByKernel.get(kernel).connections.get(connectionId)?.refs.delete(owner);
}

/**
 * Remint door. Logout/drop — not park, not last-ref.
 * Pending lease still `asyncDispose`s when it fulfills. Next `ensure` remints.
 */
export async function dropConnection(kernel: KernelRoot, connectionId: string): Promise<void> {
  if (!internByKernel.has(kernel)) return;
  const bag = internByKernel.get(kernel);
  const lease = bag.connections.get(connectionId);
  if (lease === undefined) return;
  bag.connections.delete(connectionId);
  lease.mirror?.();
  const owners = [...lease.refs];
  lease.refs.clear();
  const miss = new ConnectionMiss("connection-dropped", `connection ${connectionId} dropped`);
  const disposing = lease.pending.then(
    (instance) => {
      instance.abortOnDrop(miss);
      return instance[Symbol.asyncDispose]();
    },
    () => {},
  );
  for (const owner of owners) internOwnerOf(owner)?.forgetConnection(connectionId);
  await disposing;
}

/** Kernel teardown only. Session park is a document wrap, not a connection lifetime. */
export function disposeKernelConnections(kernel: object): void {
  if (!internByKernel.has(kernel)) return;
  const bag = internByKernel.get(kernel);
  internByKernel.delete(kernel);
  for (const lease of bag.connections.values()) {
    lease.refs.clear();
    lease.mirror?.();
    void lease.pending.then(
      (instance) => instance[Symbol.asyncDispose](),
      () => {},
    );
  }
  bag.connections.clear();
}
