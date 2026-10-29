/**
 * Production runtime over RemoteDocumentAdapter. Hydration, recovery, and
 * ownership finish before activate.
 */
import { KernelPlexus, SessionPlexus } from "@inhuman.tools/harness-model";
import { type ConnectionSpec, type DriverSpec } from "@inhuman.tools/plexus-expectations";
import * as Y from "yjs";

import type { DriverRegistry } from "@/connections";
import { documentKey, KERNEL_DOCUMENT_KEY } from "@/protocol/document";
import { ProductionRuntime, recoverSessionJobs, type RecoveredJob } from "@/runtime";
import type { KernelToolCatalog } from "@/tool-catalog";
import type { RemoteDocumentAdapter } from "@/yjs";

export type { RecoveredJob } from "@/runtime";

type KernelTables = {
  readonly connections: Record<string, ConnectionSpec | undefined>;
  readonly drivers: Record<string, DriverSpec | undefined>;
};

export type RuntimeServerOptions = {
  readonly adapter: RemoteDocumentAdapter;
  readonly registry: DriverRegistry;
  readonly catalog?: KernelToolCatalog;
};

export class RuntimeServer implements Disposable {
  #runtime: ProductionRuntime<SessionPlexus>;
  #adapter: RemoteDocumentAdapter;
  #tables: KernelTables | null = null;
  #moduleRoot: string | undefined;
  #kernel: KernelPlexus | undefined;
  #recovered = false;
  #acquiringKernel: Promise<KernelPlexus> | null = null;
  readonly #acquiring = new Map<string, Promise<SessionPlexus>>();

  constructor(options: RuntimeServerOptions) {
    this.#adapter = options.adapter;
    this.#runtime = new ProductionRuntime({
      registry: options.registry,
      catalog: options.catalog,
      documents: options.adapter,
    });
  }

  get runtime(): ProductionRuntime<SessionPlexus> {
    return this.#runtime;
  }

  get documents(): RemoteDocumentAdapter {
    return this.#adapter;
  }

  get kernel(): KernelPlexus | undefined {
    return this.#kernel;
  }

  get recovered(): boolean {
    return this.#recovered;
  }

  /** Bind has no catalog observers. */
  bind(tables: KernelTables, opts?: { readonly moduleRoot?: string }): void {
    this.#tables = tables;
    if (opts?.moduleRoot != null) this.#moduleRoot = opts.moduleRoot;
    this.#runtime.bind(tables, opts);
  }

  async acquireKernel(): Promise<KernelPlexus> {
    if (this.#kernel != null) return this.#kernel;
    if (this.#acquiringKernel != null) return this.#acquiringKernel;
    const run = this.#acquireKernelNow();
    this.#acquiringKernel = run;
    try {
      return await run;
    } finally {
      if (this.#acquiringKernel === run) this.#acquiringKernel = null;
    }
  }

  async acquireSession(sessionId: string, path = ""): Promise<SessionPlexus> {
    const live = this.#runtime.replica(sessionId);
    if (live != null) return live;
    const pending = this.#acquiring.get(sessionId);
    if (pending != null) return pending;
    const run = this.#acquireSessionNow(sessionId, path);
    this.#acquiring.set(sessionId, run);
    try {
      return await run;
    } finally {
      if (this.#acquiring.get(sessionId) === run) this.#acquiring.delete(sessionId);
    }
  }

  /** Classify interned session jobs. */
  recover(): RecoveredJob[] {
    const recovered: RecoveredJob[] = [];
    for (const replica of this.#runtime.replicaValues()) {
      recovered.push(...recoverSessionJobs(replica.root, { catalog: this.#runtime.catalog }));
    }
    this.#recovered = true;
    return recovered;
  }

  /** Catalog projection starts only after intern/recover. */
  activate(): void {
    if (!this.#recovered) {
      throw new Error("runtime: recover before activate");
    }
    this.#runtime.activate();
  }

  /**
   * Same runtime generation, new connection epoch. Re-acquires and recovers
   * the held documents. Catalog observers stay off until activate().
   */
  async reconnect(adapter: RemoteDocumentAdapter): Promise<RecoveredJob[]> {
    const sessionIds = [...this.#runtime.acquired];
    const hadKernel = this.#kernel != null;
    const tables = this.#tables;
    const moduleRoot = this.#moduleRoot;
    const registry = this.#runtime.registry;
    const catalog = this.#runtime.catalog;
    const previous = this.#adapter;
    this.#stopAwareness();
    this.#runtime[Symbol.dispose]();
    this.#kernel = undefined;
    this.#acquiringKernel = null;
    this.#acquiring.clear();
    this.#recovered = false;
    this.#adapter = adapter;
    previous[Symbol.dispose]();
    this.#runtime = new ProductionRuntime({
      registry,
      catalog,
      documents: adapter,
    });
    if (tables != null) {
      this.#runtime.bind(tables, moduleRoot == null ? undefined : { moduleRoot });
    }
    if (hadKernel) await this.acquireKernel();
    for (const id of sessionIds) await this.acquireSession(id);
    return this.recover();
  }

  [Symbol.dispose](): void {
    this.#stopAwareness();
    this.#runtime[Symbol.dispose]();
    this.#adapter[Symbol.dispose]();
  }

  /** A reconnect swapped the adapter while an acquire waited on the old one. */
  #stale(documents: RemoteDocumentAdapter): boolean {
    return this.#adapter !== documents;
  }

  async #acquireKernelNow(): Promise<KernelPlexus> {
    if (this.#kernel != null) return this.#kernel;
    const documents = this.#adapter;
    const opened = await documents.openExisting(KERNEL_DOCUMENT_KEY);
    if (this.#stale(documents)) return this.acquireKernel();
    if (opened.ok) {
      this.#kernel = KernelPlexus.connect(opened.ref.doc);
      return this.#kernel;
    }
    const boot = KernelPlexus.bootstrap();
    const created = await documents.create(KERNEL_DOCUMENT_KEY, Y.encodeStateAsUpdate(boot.doc));
    boot.doc.destroy();
    if (this.#stale(documents)) return this.acquireKernel();
    if (!created.ok) {
      throw new Error(`kernel document create failed: ${created.reason}`);
    }
    this.#kernel = KernelPlexus.connect(created.ref.doc);
    return this.#kernel;
  }

  async #acquireSessionNow(sessionId: string, path: string): Promise<SessionPlexus> {
    const live = this.#runtime.replica(sessionId);
    if (live != null) return live;
    const key = documentKey("sessions", sessionId);
    const documents = this.#adapter;
    const opened = await documents.openExisting(key);
    if (this.#stale(documents)) return this.acquireSession(sessionId, path);
    if (opened.ok) {
      const interned = this.#runtime.replica(sessionId);
      if (interned != null) return interned;
      const restored = SessionPlexus.connect(opened.ref.doc, { undo: "stub" });
      return this.#runtime.intern(sessionId, restored);
    }
    const boot = SessionPlexus.create(sessionId, path);
    const created = await documents.create(key, Y.encodeStateAsUpdate(boot.doc));
    boot.doc.destroy();
    if (this.#stale(documents)) return this.acquireSession(sessionId, path);
    if (!created.ok) {
      throw new Error(`session document create failed: ${created.reason}`);
    }
    const minted = SessionPlexus.connect(created.ref.doc, { undo: "stub" });
    return this.#runtime.intern(sessionId, minted);
  }

  #stopAwareness(): void {
    if (this.#kernel != null && !this.#kernel.doc.isDestroyed) {
      this.#kernel.awareness.destroy();
    }
    for (const session of this.#runtime.replicaValues()) {
      if (!session.doc.isDestroyed) session.awareness.destroy();
    }
  }
}
