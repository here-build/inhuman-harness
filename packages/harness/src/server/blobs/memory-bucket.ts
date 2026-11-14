import { createHash } from "node:crypto";

import { SHA256_HEX, type BlobRef } from "@inhuman.tools/harness-model";

import {
  blobKeyOf,
  sha256OfBlobKey,
  type BlobBucket,
  type BlobBucketSync,
  type BlobListOptions,
  type BlobListPage,
  type BlobStat,
} from "./bucket.js";

const DEFAULT_LIST_LIMIT = 1_000;

type StoredMemoryBlob = {
  readonly bytes: Uint8Array;
  readonly mime: string;
};

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** In-memory content-addressed blob bucket for ephemeral / server kernels without host disk I/O. */
export class MemoryBlobBucket implements BlobBucket, BlobBucketSync, Disposable {
  readonly #objects = new Map<string, StoredMemoryBlob>();

  get size(): number {
    return this.#objects.size;
  }

  putSync(bytes: Uint8Array, mime: string): BlobRef {
    const sha256 = sha256Hex(bytes);
    const key = blobKeyOf(sha256);
    if (!this.#objects.has(key)) {
      this.#objects.set(key, { bytes: Uint8Array.from(bytes), mime });
    }
    return { sha256, bytes: bytes.byteLength, mime };
  }

  getSync(key: string): Uint8Array | null {
    const sha256 = sha256OfBlobKey(key);
    if (sha256 === null) return null;
    const entry = this.#objects.get(key);
    if (entry === undefined) return null;
    return sha256Hex(entry.bytes) === sha256 ? Uint8Array.from(entry.bytes) : null;
  }

  headSync(key: string): BlobStat | null {
    const sha256 = sha256OfBlobKey(key);
    if (sha256 === null) return null;
    const entry = this.#objects.get(key);
    return entry === undefined ? null : { bytes: entry.bytes.byteLength, mime: entry.mime };
  }

  deleteSync(key: string): void {
    const sha256 = sha256OfBlobKey(key);
    if (sha256 === null) throw new RangeError(`not a blob key: ${key}`);
    this.#objects.delete(key);
  }

  deleteHash(sha256: string): void {
    if (!SHA256_HEX.test(sha256)) throw new RangeError(`not a sha256 hex digest: ${sha256}`);
    this.#objects.delete(blobKeyOf(sha256));
  }

  listHashes(): Iterable<string> {
    const hashes: string[] = [];
    for (const key of this.#objects.keys()) {
      const hex = sha256OfBlobKey(key);
      if (hex !== null) hashes.push(hex);
    }
    hashes.sort();
    return hashes;
  }

  listSync(options: BlobListOptions = {}): BlobListPage {
    const requested = options.limit ?? DEFAULT_LIST_LIMIT;
    const limit = Number.isFinite(requested) ? Math.max(1, Math.floor(requested)) : DEFAULT_LIST_LIMIT;
    const { after } = options;
    const sorted = [...this.#objects.keys()].sort().filter((key) => after === undefined || key > after);
    if (sorted.length > limit) {
      return { keys: sorted.slice(0, limit), next: sorted[limit - 1] ?? null };
    }
    return { keys: sorted, next: null };
  }

  async put(bytes: Uint8Array, mime: string): Promise<BlobRef> {
    return this.putSync(bytes, mime);
  }

  async get(key: string): Promise<Uint8Array | null> {
    return this.getSync(key);
  }

  async head(key: string): Promise<BlobStat | null> {
    return this.headSync(key);
  }

  async delete(key: string): Promise<void> {
    this.deleteSync(key);
  }

  async list(options?: BlobListOptions): Promise<BlobListPage> {
    return this.listSync(options);
  }

  [Symbol.dispose](): void {
    this.#objects.clear();
  }
}
