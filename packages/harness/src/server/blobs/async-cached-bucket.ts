import { createHash } from "node:crypto";

import { type BlobRef } from "@inhuman.tools/harness-model";

import {
  blobKeyOf,
  sha256OfBlobKey,
  type BlobBucket,
  type BlobBucketSync,
  type BlobListOptions,
  type BlobListPage,
  type BlobStat,
} from "./bucket.js";
import { blobMimeOf } from "./media.js";

const DEFAULT_LIST_LIMIT = 1_000;
const DEFAULT_MAX_CACHE_BYTES = 64 * 1024 * 1024;

type StoredBlob = {
  readonly bytes: Uint8Array;
  readonly mime: string;
};

type CacheEntry = {
  readonly bytes: Uint8Array;
  readonly mime: string;
  dirty: boolean;
  pendingUpload: Promise<void> | null;
};

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Purely asynchronous in-memory {@link BlobBucket} simulating object storage (S3/R2/GCS) for
 * server tests and remote-backed installations without implementing {@link BlobBucketSync}.
 */
export class MemoryAsyncBlobBucket implements BlobBucket, Disposable {
  readonly #objects = new Map<string, StoredBlob>();

  get size(): number {
    return this.#objects.size;
  }

  async put(bytes: Uint8Array, mime: string): Promise<BlobRef> {
    const sha256 = sha256Hex(bytes);
    const key = blobKeyOf(sha256);
    if (!this.#objects.has(key)) {
      this.#objects.set(key, { bytes: Uint8Array.from(bytes), mime });
    }
    return { sha256, bytes: bytes.byteLength, mime };
  }

  async get(key: string): Promise<Uint8Array | null> {
    const sha256 = sha256OfBlobKey(key);
    if (sha256 === null) return null;
    const entry = this.#objects.get(key);
    if (entry === undefined) return null;
    return sha256Hex(entry.bytes) === sha256 ? Uint8Array.from(entry.bytes) : null;
  }

  async head(key: string): Promise<BlobStat | null> {
    const sha256 = sha256OfBlobKey(key);
    if (sha256 === null) return null;
    const entry = this.#objects.get(key);
    return entry === undefined ? null : { bytes: entry.bytes.byteLength, mime: entry.mime };
  }

  async delete(key: string): Promise<void> {
    const sha256 = sha256OfBlobKey(key);
    if (sha256 === null) throw new RangeError(`not a blob key: ${key}`);
    this.#objects.delete(key);
  }

  async list(options: BlobListOptions = {}): Promise<BlobListPage> {
    const requested = options.limit ?? DEFAULT_LIST_LIMIT;
    const limit = Number.isFinite(requested) ? Math.max(1, Math.floor(requested)) : DEFAULT_LIST_LIMIT;
    const { after } = options;
    const sorted = [...this.#objects.keys()].sort().filter((key) => after === undefined || key > after);
    if (sorted.length > limit) {
      return { keys: sorted.slice(0, limit), next: sorted[limit - 1] ?? null };
    }
    return { keys: sorted, next: null };
  }

  [Symbol.dispose](): void {
    this.#objects.clear();
  }
}

export interface AsyncCachedBlobBucketOptions {
  readonly remote: BlobBucket;
  /** Maximum retained clean bytes in RAM. Dirty entries stay pinned until flushed. Default: 64 MiB. */
  readonly maxCacheBytes?: number;
}

/**
 * Bounded in-memory sync write-behind / read-through cache over an async {@link BlobBucket}.
 *
 * `putSync` stores an immediate defensive copy in RAM marked dirty and schedules an asynchronous
 * write to `remote`. Dirty entries are pinned against LRU eviction until `remote.put` finishes.
 */
export class AsyncCachedBlobBucket implements BlobBucket, BlobBucketSync, AsyncDisposable, Disposable {
  readonly #remote: BlobBucket;
  readonly #maxCacheBytes: number;
  readonly #cache = new Map<string, CacheEntry>();
  readonly #pendingUploads = new Set<Promise<void>>();
  #uploadErrors: unknown[] = [];
  #cachedBytes = 0;
  #disposed = false;

  constructor(options: AsyncCachedBlobBucketOptions) {
    this.#remote = options.remote;
    const maxBytes = options.maxCacheBytes ?? DEFAULT_MAX_CACHE_BYTES;
    if (!Number.isFinite(maxBytes) || maxBytes < 0) {
      throw new RangeError(`maxCacheBytes must be a non-negative finite number, got ${String(maxBytes)}`);
    }
    this.#maxCacheBytes = Math.floor(maxBytes);
  }

  get cacheBytes(): number {
    return this.#cachedBytes;
  }

  get cacheSize(): number {
    return this.#cache.size;
  }

  get dirtyCount(): number {
    let count = 0;
    for (const entry of this.#cache.values()) {
      if (entry.dirty) count++;
    }
    return count;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  putSync(bytes: Uint8Array, mime: string): BlobRef {
    this.#assertNotDisposed();
    const sha256 = sha256Hex(bytes);
    const key = blobKeyOf(sha256);
    const existing = this.#cache.get(key);
    if (existing !== undefined) {
      this.#touch(key, existing);
      return { sha256, bytes: bytes.byteLength, mime };
    }

    const copy = Uint8Array.from(bytes);
    const entry: CacheEntry = {
      bytes: copy,
      mime,
      dirty: true,
      pendingUpload: null,
    };
    this.#cache.set(key, entry);
    this.#cachedBytes += copy.byteLength;
    this.#scheduleUpload(copy, mime, entry);
    return { sha256, bytes: bytes.byteLength, mime };
  }

  getSync(key: string): Uint8Array | null {
    const sha256 = sha256OfBlobKey(key);
    if (sha256 === null) return null;
    const entry = this.#cache.get(key);
    if (entry === undefined) return null;
    this.#touch(key, entry);
    return Uint8Array.from(entry.bytes);
  }

  headSync(key: string): BlobStat | null {
    const sha256 = sha256OfBlobKey(key);
    if (sha256 === null) return null;
    const entry = this.#cache.get(key);
    if (entry === undefined) return null;
    this.#touch(key, entry);
    return { bytes: entry.bytes.byteLength, mime: entry.mime };
  }

  /** Pre-loads a set of blob keys from `remote` into the bounded cache for sync access. */
  async warm(keys: readonly string[]): Promise<void> {
    this.#assertNotDisposed();
    const unique = new Set(keys);
    await Promise.all(
      [...unique].map(async (key) => {
        const sha256 = sha256OfBlobKey(key);
        if (sha256 === null) return;
        const existing = this.#cache.get(key);
        if (existing !== undefined) {
          this.#touch(key, existing);
          return;
        }
        const [bytes, stat] = await Promise.all([this.#remote.get(key), this.#remote.head(key)]);
        if (this.#disposed || bytes === null || sha256Hex(bytes) !== sha256) return;
        // Preserve any concurrent putSync entry written while awaiting remote.
        if (this.#cache.has(key)) {
          const concurrent = this.#cache.get(key)!;
          this.#touch(key, concurrent);
          return;
        }
        const copy = Uint8Array.from(bytes);
        const entry: CacheEntry = {
          bytes: copy,
          mime: stat?.mime ?? blobMimeOf(copy),
          dirty: false,
          pendingUpload: null,
        };
        this.#cache.set(key, entry);
        this.#cachedBytes += copy.byteLength;
        this.#evictCleanLru();
      }),
    );
  }

  /** Awaits all pending write-behind uploads to `remote` and enforces clean LRU eviction. */
  async flush(): Promise<void> {
    while (this.#pendingUploads.size > 0) {
      await Promise.allSettled(this.#pendingUploads);
    }
    this.#evictCleanLru();
    if (this.#uploadErrors.length > 0) {
      const first = this.#uploadErrors[0];
      this.#uploadErrors = [];
      throw first;
    }
  }

  async put(bytes: Uint8Array, mime: string): Promise<BlobRef> {
    const ref = this.putSync(bytes, mime);
    const key = blobKeyOf(ref.sha256);
    const entry = this.#cache.get(key);
    if (entry?.pendingUpload !== null && entry?.pendingUpload !== undefined) {
      await entry.pendingUpload;
    }
    return ref;
  }

  async get(key: string): Promise<Uint8Array | null> {
    const cached = this.getSync(key);
    if (cached !== null) return cached;
    await this.warm([key]);
    return this.getSync(key);
  }

  async head(key: string): Promise<BlobStat | null> {
    const cached = this.headSync(key);
    if (cached !== null) return cached;
    return this.#remote.head(key);
  }

  async delete(key: string): Promise<void> {
    const sha256 = sha256OfBlobKey(key);
    if (sha256 === null) throw new RangeError(`not a blob key: ${key}`);
    const entry = this.#cache.get(key);
    if (entry !== undefined) {
      if (entry.pendingUpload !== null) {
        await Promise.allSettled([entry.pendingUpload]);
      }
      if (this.#cache.delete(key)) {
        this.#cachedBytes = Math.max(0, this.#cachedBytes - entry.bytes.byteLength);
      }
    }
    await this.#remote.delete(key);
  }

  async list(options?: BlobListOptions): Promise<BlobListPage> {
    await this.flush();
    return this.#remote.list(options);
  }

  [Symbol.dispose](): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#cache.clear();
    this.#cachedBytes = 0;
    this.#uploadErrors = [];
  }

  async [Symbol.asyncDispose](): Promise<void> {
    if (this.#disposed) return;
    try {
      await this.flush();
    } finally {
      this[Symbol.dispose]();
    }
  }

  #assertNotDisposed(): void {
    if (this.#disposed) {
      throw new Error("AsyncCachedBlobBucket has been disposed");
    }
  }

  #touch(key: string, entry: CacheEntry): void {
    this.#cache.delete(key);
    this.#cache.set(key, entry);
  }

  #scheduleUpload(copy: Uint8Array, mime: string, entry: CacheEntry): void {
    const pending = Promise.withResolvers<void>();
    const tracked = pending.promise;
    entry.pendingUpload = tracked;
    this.#pendingUploads.add(tracked);
    // Avoid unhandled rejection if caller uses sync write-behind before calling flush().
    void tracked.catch(() => undefined);

    void (async () => {
      try {
        await this.#remote.put(Uint8Array.from(copy), mime);
        entry.dirty = false;
        this.#evictCleanLru();
        pending.resolve();
      } catch (error) {
        this.#uploadErrors.push(error);
        pending.reject(error);
      } finally {
        this.#pendingUploads.delete(tracked);
        if (entry.pendingUpload === tracked) {
          entry.pendingUpload = null;
        }
      }
    })();
  }

  #evictCleanLru(): void {
    if (this.#cachedBytes <= this.#maxCacheBytes) return;
    for (const [key, entry] of this.#cache.entries()) {
      if (this.#cachedBytes <= this.#maxCacheBytes) break;
      if (entry.dirty) continue;
      this.#cache.delete(key);
      this.#cachedBytes = Math.max(0, this.#cachedBytes - entry.bytes.byteLength);
    }
  }
}
