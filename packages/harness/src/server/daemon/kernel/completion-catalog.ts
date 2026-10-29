/**
 * Kernel intern of completion connections so CLI `--model` can read live ids.
 * Shares the intern table with session `orchestrator.ensure`. Rejected:
 * intern via session `kv/set` — a remembered model/connection write lands
 * last-choice onto project and kernel while walking candidates.
 */
import type { PlexusAwareness } from "@here.build/plexus";
import type { ConnectModelsRow } from "@inhuman.tools/harness-contract";
import { fail } from "@inhuman.tools/harness-diagnostics";
import { liveModelsOf } from "@inhuman.tools/harness-scheme";
import { revalidationDemandOf, type ConnectionSpec } from "@inhuman.tools/plexus-expectations";
import { action, comparer, reaction, type IReactionDisposer } from "mobx";

import { completionConnectionIds, type CredentialsStore } from "@/connections";
import type { ProductionRuntime } from "@/runtime";

import { RpcInvalidParams } from "../../contract.js";
import { readConnectionSecrets, writeConnectionSecrets } from "../../secrets.js";

export type CompletionCatalogHost = {
  readonly root: string;
  readonly runtime: ProductionRuntime;
  readonly plexus: {
    readonly awareness: PlexusAwareness;
    readonly root: {
      readonly connections: Record<string, ConnectionSpec | undefined>;
    };
  };
};

function kernelSecrets(root: string): CredentialsStore {
  return {
    read: (id) => readConnectionSecrets(root, id),
    write: (id, secrets) => writeConnectionSecrets(root, id, { ...secrets }),
  };
}

export async function probeCompletionCatalog(
  host: CompletionCatalogHost,
  internOwner: object,
  id?: string,
): Promise<ConnectModelsRow[]> {
  const connections = host.plexus.root.connections;
  let catalog: string[];
  try {
    catalog = completionConnectionIds(connections, id);
  } catch (error) {
    throw new RpcInvalidParams(error instanceof Error ? error.message : String(error));
  }
  const secrets = kernelSecrets(host.root);
  return Promise.all(
    catalog.map(async (key) => {
      const spec = connections[key];
      RpcInvalidParams.invariant(spec !== undefined, `unknown connection ${key}`);
      try {
        await host.runtime.internDiscovery(host.plexus.root, internOwner, key, {
          secrets,
          awareness: host.plexus.awareness,
        });
      } catch (error) {
        fail(`connect/models ${key}`, error);
        if (spec.error.trim() === "") {
          action(() => {
            spec.error = error instanceof Error ? error.message : String(error);
          })();
        }
      }
      return { id: key, models: liveModelsOf(spec), error: spec.error };
    }),
  );
}

/**
 * A completion connection a client is looking at (a picker, `/connect`) is
 * interned, so its catalog and account poll before any turn names it.
 */
export function internLookedAt(host: CompletionCatalogHost, internOwner: object): IReactionDisposer {
  return reaction(
    () =>
      completionConnectionIds(host.plexus.root.connections).filter(
        (id) => revalidationDemandOf(host.plexus.awareness, { kind: "connection", id }) !== "none",
      ),
    (ids) => {
      for (const id of ids) void probeCompletionCatalog(host, internOwner, id);
    },
    { equals: comparer.structural, fireImmediately: true },
  );
}
