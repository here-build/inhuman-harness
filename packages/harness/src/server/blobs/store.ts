/**
 * The kernel's blob bucket, seated for the daemon. The two places that stamp a file's prior text put through the
 * writer port that turn exposes; providers read through the reader port of harness-provider-sdk; the `blob/get`
 * handler reads through {@link BlobStore.readSync} (or {@link readBlobSync} for single-kernel local compatibility).
 */
import { fail } from "@inhuman.tools/harness-diagnostics";
import { SHA256_HEX } from "@inhuman.tools/harness-model";
import { bindBlobReader } from "@inhuman.tools/harness-provider-sdk";
import { bindBlobWriter, type BlobWriter } from "@inhuman.tools/turn/tool-runtime";

import { blobKeyOf, type BlobBucketSync } from "./bucket.js";
import { FsBlobBucket } from "./fs-bucket.js";
import { blobMimeOf } from "./media.js";

export type BlobBody = {
  readonly bytes: Uint8Array;
  /** What the bucket recorded for the object, or what the bytes look like when it recorded none. */
  readonly mime: string;
};

/** Instance-owned blob store backing a single KernelDaemon without polluting process-global state. */
export class BlobStore implements Disposable {
  readonly #ownsBucket: boolean;
  #disposed = false;

  constructor(
    readonly bucket: BlobBucketSync,
    options?: { readonly ownsBucket?: boolean },
  ) {
    this.#ownsBucket = options?.ownsBucket ?? true;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  readonly write: BlobWriter = (bytes, mime) => {
    try {
      return this.bucket.putSync(bytes, mime);
    } catch (error) {
      // The stamping site keeps the text inline; the log says why.
      fail("blob bucket refused a put", error);
      throw error;
    }
  };

  readonly readBytes = (sha256: string): Uint8Array | null => {
    if (!SHA256_HEX.test(sha256)) return null;
    return this.bucket.getSync(blobKeyOf(sha256));
  };

  readSync(sha256: string): BlobBody | null {
    const key = blobKeyOf(sha256);
    const bytes = this.bucket.getSync(key);
    if (bytes === null) return null;
    return { bytes, mime: this.bucket.headSync(key)?.mime ?? blobMimeOf(bytes) };
  }

  [Symbol.dispose](): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#ownsBucket && Symbol.dispose in this.bucket && typeof this.bucket[Symbol.dispose] === "function") {
      (this.bucket as Disposable)[Symbol.dispose]();
    }
  }
}

let seated: BlobStore | null = null;

/** Seats the directory bucket under the kernel root and binds both ports to it. */
export function bindBlobStore(root: string): void {
  bindBlobBucket(new FsBlobBucket(root));
}

/** Seats any bucket; a remote one takes this door. `null` unseats and unbinds both ports. */
export function bindBlobBucket(bucket: BlobBucketSync | null): void {
  seated = bucket === null ? null : new BlobStore(bucket, { ownsBucket: false });
  bindBlobWriter(seated === null ? null : seated.write);
  bindBlobReader(seated === null ? null : seated.readBytes);
}

/** Null while no bucket is seated, for a hash the bucket does not hold, and for bytes that no longer match it. */
export function readBlobSync(sha256: string): BlobBody | null {
  return seated === null ? null : seated.readSync(sha256);
}
