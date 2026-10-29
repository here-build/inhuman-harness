/* eslint-disable security/detect-non-literal-fs-filename -- every path is the bucket's own directory plus a name checked to be 64 lowercase hex */
/**
 * The first blob bucket: a directory under the kernel root.
 *
 *   <root>/blobs/sha256/<hex[0:2]>/<hex>   one object per content hash
 *   <root>/blobs/tmp/<uuid>                a body being written; renamed onto its object, never read
 *
 * Directories are 0700 and files 0600, as for pictures. An object appears whole or not at all: it is written
 * to `tmp` and renamed. Every read checks the bytes against the hash in the key, so a torn or edited file
 * reads as missing instead of as a different fact.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { SHA256_HEX, type BlobRef } from "@inhuman.tools/harness-model";

import {
  BLOB_KEY_PREFIX,
  blobKeyOf,
  sha256OfBlobKey,
  type BlobBucket,
  type BlobBucketSync,
  type BlobListOptions,
  type BlobListPage,
  type BlobStat,
} from "./bucket.js";

const DEFAULT_LIST_LIMIT = 1_000;
const FAN_OUT = /^[0-9a-f]{2}$/;

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sizeOf(path: string): number | null {
  try {
    const info = statSync(path);
    return info.isFile() ? info.size : null;
  } catch {
    return null;
  }
}

export class FsBlobBucket implements BlobBucket, BlobBucketSync {
  readonly #base: string;

  /** @param root the kernel root; the bucket lives in `<root>/blobs`, created on the first put. */
  constructor(root: string) {
    this.#base = join(root, "blobs");
  }

  putSync(bytes: Uint8Array, mime: string): BlobRef {
    const sha256 = sha256Hex(bytes);
    const target = this.#pathOf(sha256);
    // Same hash, same size: the object is already here. A different size is a torn or edited file, rewritten whole.
    if (sizeOf(target) !== bytes.byteLength) this.#write(target, bytes);
    return { sha256, bytes: bytes.byteLength, mime };
  }

  getSync(key: string): Uint8Array | null {
    const sha256 = sha256OfBlobKey(key);
    if (sha256 === null) return null;
    let bytes: Buffer;
    try {
      bytes = readFileSync(this.#pathOf(sha256));
    } catch {
      return null;
    }
    return sha256Hex(bytes) === sha256 ? bytes : null;
  }

  headSync(key: string): BlobStat | null {
    const sha256 = sha256OfBlobKey(key);
    if (sha256 === null) return null;
    const bytes = sizeOf(this.#pathOf(sha256));
    return bytes === null ? null : { bytes, mime: null };
  }

  deleteSync(key: string): void {
    const sha256 = sha256OfBlobKey(key);
    if (sha256 === null) throw new RangeError(`not a blob key: ${key}`);
    rmSync(this.#pathOf(sha256), { force: true });
  }

  listSync(options: BlobListOptions = {}): BlobListPage {
    const requested = options.limit ?? DEFAULT_LIST_LIMIT;
    const limit = Number.isFinite(requested) ? Math.max(1, Math.floor(requested)) : DEFAULT_LIST_LIMIT;
    const { after } = options;
    const keys: string[] = [];
    for (const fan of this.#names(join(this.#base, "sha256"), FAN_OUT)) {
      // Every key in this directory starts with `sha256/<fan>`; when that sorts before `after`'s same-length prefix, they all do.
      if (after !== undefined && `${BLOB_KEY_PREFIX}${fan}` < after.slice(0, BLOB_KEY_PREFIX.length + 2)) continue;
      for (const name of this.#names(join(this.#base, "sha256", fan), SHA256_HEX)) {
        if (!name.startsWith(fan)) continue;
        const key = blobKeyOf(name);
        if (after !== undefined && key <= after) continue;
        keys.push(key);
        // One past the page tells whether another page exists.
        if (keys.length > limit) return { keys: keys.slice(0, limit), next: keys[limit - 1] ?? null };
      }
    }
    return { keys, next: null };
  }

  // The async face of a directory: the work is synchronous file I/O, and a throw becomes a rejection.

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

  #pathOf(sha256: string): string {
    return join(this.#base, "sha256", sha256.slice(0, 2), sha256);
  }

  /** The names in a directory that match, sorted; none when the directory does not exist yet. */
  #names(dir: string, pattern: RegExp): string[] {
    try {
      return readdirSync(dir)
        .filter((name) => pattern.test(name))
        .sort();
    } catch {
      return [];
    }
  }

  #write(target: string, bytes: Uint8Array): void {
    const tmpDir = join(this.#base, "tmp");
    mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    const tmp = join(tmpDir, randomUUID());
    try {
      const fd = openSync(tmp, "wx", 0o600);
      try {
        writeFileSync(fd, bytes);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, target);
    } catch (error) {
      rmSync(tmp, { force: true });
      throw error;
    }
  }
}
