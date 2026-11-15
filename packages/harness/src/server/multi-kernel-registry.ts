/**
 * Multi-tenant server registry mapping `kernelId` -> pooled `KernelDaemon`.
 *
 * Shares one Agent DB (`HarnessKvStore`) and one `ShapeSource` across tenant
 * kernels in the `"server"` contour while giving each kernel its own isolated
 * secrets vault, blob bucket, visual store, and idle-eviction lifecycle.
 */
import { AsyncDisposableClass } from "@inhuman.tools/harness-commons";
import { fail } from "@inhuman.tools/harness-diagnostics";
import type { InhumanPlugin } from "@inhuman.tools/plugin-sdk";
import { CommitDiffShapeSource, type HarnessKvStore, type ShapeSource } from "@inhuman.tools/scope-plane";

import type { DriverRegistry } from "@/connections";

import type { BlobBucketSync } from "./blobs/bucket.js";
import { KernelDaemon } from "./daemon/kernel/KernelDaemon.js";
import type { VisualStorePort } from "./daemon/session/visual-store.js";
import type { SecretsVaultPort } from "./secrets.js";

export type MultiKernelRegistryOptions = {
  readonly db: HarnessKvStore;
  readonly ownsDb?: boolean;
  readonly laneHub?: ShapeSource;
  readonly ownsLaneHub?: boolean;
  /** Idle TTL after the last lease is released. Values `<= 0` disable timer eviction. */
  readonly idleEvictMs?: number;
  readonly createSecretsVault?: (kernelId: string) => SecretsVaultPort;
  readonly createBlobBucket?: (kernelId: string) => BlobBucketSync;
  readonly createVisualStore?: (kernelId: string) => VisualStorePort;
  readonly createRegistry?: (kernelId: string) => DriverRegistry;
  readonly bundledPlugins?: ReadonlyArray<{ readonly npmName: string; readonly rootPath: string }>;
  readonly runtimePlugins?: Readonly<Record<string, InhumanPlugin>>;
};

export interface KernelLease extends Disposable, AsyncDisposable {
  readonly kernelId: string;
  readonly kernel: KernelDaemon;
}

type RegistryEntry = {
  readonly kernelId: string;
  readonly kernel: KernelDaemon;
  leases: number;
  lastReleasedAtMs: number;
  idleTimer: NodeJS.Timeout | null;
};

export class MultiKernelRegistry extends AsyncDisposableClass {
  readonly db: HarnessKvStore;
  readonly laneHub: ShapeSource;
  readonly #ownsDb: boolean;
  readonly #ownsLaneHub: boolean;
  readonly #idleEvictMs: number;
  readonly #options: MultiKernelRegistryOptions;
  readonly #entries = new Map<string, RegistryEntry>();
  readonly #evicting = new Map<string, Promise<void>>();

  constructor(options: MultiKernelRegistryOptions) {
    super();
    this.db = options.db;
    this.#ownsDb = options.ownsDb ?? false;
    this.laneHub = options.laneHub ?? new CommitDiffShapeSource(options.db);
    this.#ownsLaneHub = options.ownsLaneHub ?? options.laneHub === undefined;
    this.#idleEvictMs = options.idleEvictMs ?? 0;
    this.#options = options;
  }

  get size(): number {
    return this.#entries.size;
  }

  has(kernelId: string): boolean {
    return this.#entries.has(kernelId);
  }

  peek(kernelId: string): KernelDaemon | undefined {
    return this.#entries.get(kernelId)?.kernel;
  }

  activeKernelIds(): string[] {
    return [...this.#entries.keys()];
  }

  async acquire(kernelId: string): Promise<KernelLease> {
    if (this.disposed || this.disposing) {
      throw new Error("MultiKernelRegistry: disposed");
    }
    while (this.#evicting.has(kernelId)) {
      await this.#evicting.get(kernelId);
    }
    if (this.disposed || this.disposing) {
      throw new Error("MultiKernelRegistry: disposed");
    }

    let entry = this.#entries.get(kernelId);
    if (entry === undefined) {
      const secrets = this.#options.createSecretsVault?.(kernelId);
      const blobBucket = this.#options.createBlobBucket?.(kernelId);
      const visuals = this.#options.createVisualStore?.(kernelId);
      const registry = this.#options.createRegistry?.(kernelId);
      const kernel = new KernelDaemon({
        contour: "server",
        kernelId,
        db: this.db,
        ownsDb: false,
        laneHub: this.laneHub,
        ownsLaneHub: false,
        ...(secrets !== undefined ? { secrets, ownsSecrets: true } : {}),
        ...(blobBucket !== undefined ? { blobBucket, ownsBlobs: true } : {}),
        ...(visuals !== undefined ? { visuals, ownsVisuals: true } : {}),
        ...(registry !== undefined ? { registry } : {}),
        ...(this.#options.bundledPlugins !== undefined ? { bundledPlugins: this.#options.bundledPlugins } : {}),
        ...(this.#options.runtimePlugins !== undefined ? { runtimePlugins: this.#options.runtimePlugins } : {}),
      });
      entry = {
        kernelId,
        kernel,
        leases: 0,
        lastReleasedAtMs: Date.now(),
        idleTimer: null,
      };
      this.#entries.set(kernelId, entry);
    }

    if (entry.idleTimer !== null) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
    entry.leases += 1;

    try {
      await entry.kernel.ready;
    } catch (error) {
      this.#releaseAfterFailedReady(entry);
      throw error;
    }

    if (this.disposed || this.disposing || entry.kernel.disposed) {
      this.#releaseLease(entry);
      throw new Error("MultiKernelRegistry: disposed");
    }

    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      this.#releaseLease(entry);
    };

    return {
      kernelId,
      kernel: entry.kernel,
      [Symbol.dispose]: release,
      [Symbol.asyncDispose]: async () => {
        release();
      },
    };
  }

  async withKernel<T>(kernelId: string, fn: (kernel: KernelDaemon) => Promise<T> | T): Promise<T> {
    const lease = await this.acquire(kernelId);
    try {
      return await fn(lease.kernel);
    } finally {
      lease[Symbol.dispose]();
    }
  }

  async evict(kernelId: string, options?: { readonly force?: boolean }): Promise<boolean> {
    const entry = this.#entries.get(kernelId);
    if (entry === undefined) {
      const pending = this.#evicting.get(kernelId);
      if (pending !== undefined) {
        await pending;
        return true;
      }
      return false;
    }
    if (options?.force !== true && !this.#isIdle(entry)) {
      return false;
    }
    if (entry.idleTimer !== null) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
    this.#entries.delete(kernelId);
    let evictPromise: Promise<void> | undefined;
    evictPromise = (async () => {
      try {
        await entry.kernel[Symbol.asyncDispose]();
      } finally {
        if (this.#evicting.get(kernelId) === evictPromise) {
          this.#evicting.delete(kernelId);
        }
      }
    })();
    this.#evicting.set(kernelId, evictPromise);
    await evictPromise;
    return true;
  }

  async evictIdleNow(now?: number): Promise<number> {
    let evicted = 0;
    for (const [kernelId, entry] of [...this.#entries.entries()]) {
      if (!this.#isIdle(entry)) continue;
      if (now !== undefined && this.#idleEvictMs > 0 && now - entry.lastReleasedAtMs < this.#idleEvictMs) {
        continue;
      }
      if (await this.evict(kernelId)) {
        evicted += 1;
      }
    }
    return evicted;
  }

  #isIdle(entry: RegistryEntry): boolean {
    return entry.leases === 0 && entry.kernel.liveSessionRoots().length === 0;
  }

  #releaseAfterFailedReady(entry: RegistryEntry): void {
    entry.leases = Math.max(0, entry.leases - 1);
    if (entry.leases === 0 && this.#entries.get(entry.kernelId) === entry) {
      if (entry.idleTimer !== null) {
        clearTimeout(entry.idleTimer);
        entry.idleTimer = null;
      }
      this.#entries.delete(entry.kernelId);
      void entry.kernel[Symbol.asyncDispose]().catch(() => undefined);
    }
  }

  #releaseLease(entry: RegistryEntry): void {
    entry.leases = Math.max(0, entry.leases - 1);
    entry.lastReleasedAtMs = Date.now();
    if (
      entry.leases === 0 &&
      !this.disposed &&
      !this.disposing &&
      this.#entries.get(entry.kernelId) === entry &&
      this.#idleEvictMs > 0 &&
      entry.idleTimer === null
    ) {
      entry.idleTimer = setTimeout(() => {
        entry.idleTimer = null;
        void this.evict(entry.kernelId).catch((error: unknown) => fail(`multi-kernel evict ${entry.kernelId}`, error));
      }, this.#idleEvictMs);
      entry.idleTimer.unref();
    }
  }

  protected override async disposeAsync(): Promise<void> {
    for (const entry of this.#entries.values()) {
      if (entry.idleTimer !== null) {
        clearTimeout(entry.idleTimer);
        entry.idleTimer = null;
      }
    }
    const activeIds = [...this.#entries.keys()];
    await Promise.allSettled(activeIds.map((id) => this.evict(id, { force: true })));
    if (this.#evicting.size > 0) {
      await Promise.allSettled(this.#evicting.values());
    }
    if (this.#ownsLaneHub) {
      this.laneHub.dispose();
    }
    if (this.#ownsDb) {
      await this.db.close();
    }
  }
}
