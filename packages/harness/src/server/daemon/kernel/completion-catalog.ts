/**
 * Kernel intern of completion connections so CLI `--model` can read live ids.
 * Shares the intern table with session `orchestrator.ensure`. Rejected:
 * intern via session `kv/set` — a remembered model/connection write lands
 * last-choice onto project and kernel while walking candidates.
 */
import type { ConnectModelsRow } from "@inhuman.tools/harness-contract";
import { fail } from "@inhuman.tools/harness-diagnostics";
import { liveModelsOf } from "@inhuman.tools/harness-scheme";
import type { ReactiveAwareness } from "@inhuman.tools/model";
import { revalidationDemandOf, type ConnectionSpec } from "@inhuman.tools/expectations";
import { action, comparer, reaction, type IReactionDisposer } from "mobx";

import { completionConnectionIds, type CredentialsStore } from "@/connections";
import type { ProductionRuntime } from "@/runtime";

import { RpcInvalidParams } from "../../contract.js";
import { readConnectionSecrets, writeConnectionSecrets, type SecretsVaultPort } from "../../secrets.js";

export type CompletionCatalogHost = {
  readonly root: string;
  readonly secrets?: SecretsVaultPort;
  readonly runtime: ProductionRuntime;
  readonly doc: {
    readonly awareness: ReactiveAwareness;
    readonly root: {
      readonly connections: Record<string, ConnectionSpec | undefined>;
    };
  };
};

function kernelSecrets(host: CompletionCatalogHost): CredentialsStore {
  if (host.secrets !== undefined) {
    const secrets = host.secrets;
    return {
      read: (id) => secrets.readConnectionSecrets(id),
      write: (id, bag) => secrets.writeConnectionSecrets(id, { ...bag }),
    };
  }
  return {
    read: (id) => readConnectionSecrets(host.root, id),
    write: (id, secrets) => writeConnectionSecrets(host.root, id, { ...secrets }),
  };
}

export async function probeCompletionCatalog(
  host: CompletionCatalogHost,
  internOwner: object,
  id?: string,
): Promise<ConnectModelsRow[]> {
  const connections = host.doc.root.connections;
  let catalog: string[];
  try {
    catalog = completionConnectionIds(connections, id);
  } catch (error) {
    throw new RpcInvalidParams(error instanceof Error ? error.message : String(error));
  }
  const secrets = kernelSecrets(host);
  return Promise.all(
    catalog.map(async (key) => {
      const spec = connections[key];
      RpcInvalidParams.invariant(spec !== undefined, `unknown connection ${key}`);
      try {
        await host.runtime.internDiscovery(host.doc.root, internOwner, key, {
          secrets,
          awareness: host.doc.awareness,
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
 * The model list only renders a completion connection once `live.models` is
 * non-empty, and it only publishes demand for rows it renders. A just-adopted
 * connection therefore never becomes looked-at, and its catalog stays empty.
 * Warm it after the row and its secrets are on disk, and again at boot for
 * rows adopted by an older process.
 */
export function warmCompletionCatalog(host: CompletionCatalogHost, internOwner: object, id?: string): void {
  if (id !== undefined) {
    const spec = host.doc.root.connections[id];
    if (spec == null || !spec.driver.abilityClaim.includes("completion") || spec.configuration.enabled === false) {
      return;
    }
  }
  void probeCompletionCatalog(host, internOwner, id);
}

/**
 * A completion connection a client is looking at (a picker, `/connect`) is
 * interned, so its catalog and account poll before any turn names it.
 */
export function internLookedAt(host: CompletionCatalogHost, internOwner: object): IReactionDisposer {
  return reaction(
    () =>
      completionConnectionIds(host.doc.root.connections).filter(
        (id) => revalidationDemandOf(host.doc.awareness, { kind: "connection", id }) !== "none",
      ),
    (ids) => {
      for (const id of ids) void probeCompletionCatalog(host, internOwner, id);
    },
    { equals: comparer.structural, fireImmediately: true },
  );
}
