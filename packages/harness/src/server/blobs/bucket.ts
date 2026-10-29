/**
 * The blob bucket, S3-shaped. A key is a content address, `sha256/<hex>`; the bytes behind a key never change,
 * so `put` is idempotent and two equal bodies are one object. The directory bucket under the kernel root is the
 * first implementation. A remote one (S3, R2, MinIO) implements the same interface, and nothing above it knows
 * which is bound.
 */
import { SHA256_HEX, type BlobRef } from "@inhuman.tools/harness-model";

export const BLOB_KEY_PREFIX = "sha256/";

/** The object key of a hash. Does not check the hash; the bucket refuses a malformed key where it is used. */
export function blobKeyOf(sha256: string): string {
  return `${BLOB_KEY_PREFIX}${sha256}`;
}

/** The hash inside a `sha256/<hex>` key, or null when the key is anything else. */
export function sha256OfBlobKey(key: string): string | null {
  if (!key.startsWith(BLOB_KEY_PREFIX)) return null;
  const hex = key.slice(BLOB_KEY_PREFIX.length);
  return SHA256_HEX.test(hex) ? hex : null;
}

/** What `head` knows about one object. The directory bucket does not record a media type; the reference does. */
export type BlobStat = {
  readonly bytes: number;
  readonly mime: string | null;
};

export type BlobListOptions = {
  /** Exclusive: keys sort strictly after it. Pass the previous page's `next`. */
  readonly after?: string;
  /** Page size, at least 1. */
  readonly limit?: number;
};

export type BlobListPage = {
  /** In key order. */
  readonly keys: readonly string[];
  /** The key to pass as `after` for the next page, or null when this was the last. */
  readonly next: string | null;
};

export interface BlobBucket {
  /** Stores the bytes under their hash and returns the reference. Storing equal bytes again writes nothing new. */
  put(bytes: Uint8Array, mime: string): Promise<BlobRef>;
  /** Null when the key is unknown, malformed, or its bytes no longer match their hash. */
  get(key: string): Promise<Uint8Array | null>;
  head(key: string): Promise<BlobStat | null>;
  /** Idempotent. A malformed key is refused. */
  delete(key: string): Promise<void>;
  list(options?: BlobListOptions): Promise<BlobListPage>;
}

/**
 * The same bucket for the daemon's synchronous paths: the stamping of a job (`externalizePrior`) and the
 * `blob/get` handler cannot await.
 */
export interface BlobBucketSync {
  putSync(bytes: Uint8Array, mime: string): BlobRef;
  getSync(key: string): Uint8Array | null;
  headSync(key: string): BlobStat | null;
}
