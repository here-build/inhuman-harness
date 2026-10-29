/**
 * Production runtime assembly. Catalog, registered drivers, MCP projection,
 * and session replica intern bind here. Observers start on activate.
 * Callers supply the completion roster. MCP catalog projection is the one concrete provider this package imports.
 */
import type { SessionRoot } from "@inhuman.tools/harness-model";
import type { ConnectionSpec, DriverSpec } from "@inhuman.tools/plexus-expectations";
import type {
  ConnectionSecretsView,
  DriverConnectionClass,
  PEWDriver,
} from "@inhuman.tools/plexus-expectations/driver";
import { acquireConnection } from "@inhuman.tools/plexus-expectations/executor";
import { action } from "mobx";

import {
  adoptRegisteredDriver,
  applyRegistryToDrivers,
  externalLoaderFor,
  loadDriverModule,
  secretsView,
  type AdoptCallback,
  type CredentialsStore,
  type DriverAdoptArgs,
  type DriverInventory,
  type DriverRegistry,
  type InternKernel,
  type ResolveOptions,
  type ResolvePurpose,
} from "@/connections";
import type { DocumentCheckpoint, DocumentKey, FlushResult } from "@/protocol/document";
import { KernelToolCatalog as CatalogTable, type KernelToolCatalog } from "@/tool-catalog";
import type { CreateResult, DocumentRef, OpenResult } from "@/yjs";

import { McpConnectionToolCatalogHost } from "./connection-tools.js";
import { isConversationSession } from "./eligibility.js";
import { collectDelegatedGrants } from "./grants.js";
import type { EligibilitySnapshot } from "./types.js";

type KernelTables = {
  readonly connections: Record<string, ConnectionSpec | undefined>;
  readonly drivers: Record<string, DriverSpec | undefined>;
};

/**
 * Smallest document face ProductionRuntime stores. DocumentService and
 * RemoteDocumentAdapter both satisfy it; this package is not an image writer.
 */
export interface RuntimeDocuments {
  readonly serverEpoch: number;
  getLoaded(key: DocumentKey): DocumentRef | undefined;
  loaded(): readonly DocumentRef[];
  checkpoint(key: DocumentKey): DocumentCheckpoint | undefined;
  openExisting(key: DocumentKey): Promise<OpenResult>;
  create(key: DocumentKey, initial?: Uint8Array): Promise<CreateResult>;
  flush(
    key: DocumentKey,
    checkpoint: DocumentCheckpoint,
    options?: {
      readonly runtimeGeneration?: number;
      readonly connectionEpoch?: number;
    },
  ): Promise<FlushResult>;
  release(key: DocumentKey): void | Promise<void>;
}

type RuntimeOpts = {
  readonly registry: DriverRegistry;
  readonly catalog?: KernelToolCatalog;
  readonly moduleRoot?: string;
  readonly documents?: RuntimeDocuments;
};

function secretsOf(secrets: CredentialsStore | ConnectionSecretsView, connectionId: string): ConnectionSecretsView {
  if (typeof (secrets as CredentialsStore).read === "function") {
    return secretsView(secrets as CredentialsStore, connectionId);
  }
  return secrets as ConnectionSecretsView;
}

function bindAwareness(instance: PEWDriver, awareness: PEWDriver["awareness"]): void {
  if (awareness === undefined) return;
  action(() => {
    instance.awareness = awareness;
  })();
}

export class ProductionRuntime<
  T extends { readonly root: SessionRoot } = { readonly root: SessionRoot },
> implements Disposable {
  readonly catalog: KernelToolCatalog;
  readonly registry: DriverRegistry;
  readonly documents: RuntimeDocuments | undefined;
  readonly #replicas = new Map<string, T>();
  #moduleRoot: string | undefined;
  #tables: KernelTables | null = null;
  #connectionHost: McpConnectionToolCatalogHost | null = null;
  #activated = false;

  constructor(opts: RuntimeOpts) {
    this.registry = opts.registry;
    this.catalog = opts.catalog ?? new CatalogTable();
    this.#moduleRoot = opts.moduleRoot;
    this.documents = opts.documents;
  }

  get activated(): boolean {
    return this.#activated;
  }

  /** Stamp registered drivers onto the kernel table. No observers. */
  bind(tables: KernelTables, opts?: { readonly moduleRoot?: string }): void {
    if (opts?.moduleRoot != null) this.#moduleRoot = opts.moduleRoot;
    applyRegistryToDrivers(this.registry, tables.drivers);
    this.#tables = tables;
  }

  /**
   * Start catalog projection. Honor, intern, and child processes stay with
   * the caller; this only attaches the connection-tool host.
   */
  activate(): void {
    if (this.#activated) return;
    const tables = this.#tables;
    if (tables == null) {
      throw new Error("runtime: bind kernel tables before activate");
    }
    this.#activated = true;
    this.#connectionHost = new McpConnectionToolCatalogHost(this.catalog, tables.connections);
  }

  intern(sessionId: string, replica: T): T {
    this.#replicas.set(sessionId, replica);
    return replica;
  }

  replica(sessionId: string): T | undefined {
    return this.#replicas.get(sessionId);
  }

  get acquired(): ReadonlySet<string> {
    return new Set(this.#replicas.keys());
  }

  replicaEntries(): IterableIterator<[string, T]> {
    return this.#replicas.entries();
  }

  replicaValues(): IterableIterator<T> {
    return this.#replicas.values();
  }

  eligibilitySnapshot(facts: {
    readonly occupied: ReadonlySet<string>;
    readonly reserved: ReadonlySet<string>;
    readonly resident?: ReadonlySet<string>;
    readonly conversations?: ReadonlySet<string>;
  }): EligibilitySnapshot {
    const acquired = this.acquired;
    const resident = new Set(facts.resident);
    const conversations = new Set(facts.conversations);
    if (facts.resident == null || facts.conversations == null) {
      for (const [id, replica] of this.#replicas) {
        if (facts.resident == null && replica.root.agent.spec.resident) {
          resident.add(id);
        }
        if (facts.conversations == null && isConversationSession(replica.root)) {
          conversations.add(id);
        }
      }
    }
    return {
      acquired,
      occupied: facts.occupied,
      resident,
      reserved: facts.reserved,
      conversations,
      grants: collectDelegatedGrants(this, acquired),
    };
  }

  #resolveOptions(extra: ResolveOptions = {}): ResolveOptions {
    const loadExternal =
      extra.loadExternal ?? (this.#moduleRoot == null ? undefined : externalLoaderFor(this.#moduleRoot));
    return loadExternal == null ? extra : { ...extra, loadExternal };
  }

  adopt(
    driverName: string,
    inventory: DriverInventory,
    args: DriverAdoptArgs,
    callback: AdoptCallback,
    options: ResolveOptions = {},
  ) {
    return adoptRegisteredDriver(this.registry, driverName, inventory, args, callback, this.#resolveOptions(options));
  }

  /**
   * Registered in-process class wins by name. Unregistered importPath uses
   * the injected loader.
   */
  loadDriver(
    driver: { readonly name: string; readonly importPath: string },
    purpose: ResolvePurpose = "execution",
  ): DriverConnectionClass | Promise<DriverConnectionClass> {
    const registered = this.registry.get(driver.name);
    if (registered !== undefined) return registered.connection;
    return loadDriverModule(this.registry, driver, this.#resolveOptions({ purpose }));
  }

  /**
   * Resolve the class before PEW intern so a descriptor miss does not leave
   * a rejected lease. Same name-wins door as {@link loadDriver}.
   */
  async internDiscovery(
    kernel: InternKernel,
    owner: object,
    connectionId: string,
    options: {
      readonly secrets: CredentialsStore | ConnectionSecretsView;
      readonly awareness?: PEWDriver["awareness"];
    },
  ): Promise<PEWDriver> {
    const spec = kernel.connections[connectionId];
    if (spec === undefined) {
      throw new Error(`connections: unknown connection ${connectionId}`);
    }
    const connectionClass = await this.loadDriver(spec.driver, "discovery");
    const secrets = secretsOf(options.secrets, connectionId);
    const instance = await acquireConnection(kernel, owner, connectionId, async () => {
      const minted = new connectionClass(connectionId, spec.configuration, secrets);
      bindAwareness(minted, options.awareness);
      return minted;
    });
    bindAwareness(instance, options.awareness);
    await instance.ensureBootstrapStarted();
    return instance;
  }

  [Symbol.dispose](): void {
    this.#connectionHost?.[Symbol.dispose]();
    this.#connectionHost = null;
    this.#activated = false;
    this.#replicas.clear();
  }
}
