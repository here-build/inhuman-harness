/**
 * Catalog and replica surfaces this package observes.
 * Creation/activation of sessions stays in runtime composition.
 */
import type { SessionRoot } from "@inhuman.tools/harness-model";
import type { Job } from "@inhuman.tools/plexus-expectations";

import type { CatalogEntry } from "../tool-catalog/index.js";

export type CallsCatalog = {
  catalogEntry(wireName: string): CatalogEntry | undefined;
  readonly botRevisions: ReadonlyMap<string, string>;
  readonly pluginInstall?: {
    readonly plugins: ReadonlyMap<string, { readonly definition: unknown }>;
  };
};

/** Already-acquired session replica. Lookup here must not mint or hydrate. */
export type AcquiredReplica = {
  readonly root: SessionRoot;
  loadEntity(uuid: string): unknown;
};

export type AgentCallScope = {
  replica(sessionId: string): AcquiredReplica | undefined;
  abortJob?(sessionId: string, job: Job): void;
};

export type AgentRuntimeHost = {
  readonly caller: SessionRoot;
  readonly catalog: CallsCatalog;
  readonly scope: AgentCallScope;
};
