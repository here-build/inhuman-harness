/**
 * The kernel's blob bucket, seated for the daemon. The two places that stamp a file's prior text put through the
 * writer port that turn exposes; providers read through the reader port of harness-provider-sdk; the `blob/get`
 * handler reads through {@link readBlobSync}. Seated once at kernel boot, like the picture store.
 */
import { fail } from "@inhuman.tools/harness-diagnostics";
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

let seated: BlobBucketSync | null = null;

/** Seats the directory bucket under the kernel root and binds both ports to it. */
export function bindBlobStore(root: string): void {
  bindBlobBucket(new FsBlobBucket(root));
}

/** Seats any bucket; a remote one takes this door. `null` unseats and unbinds both ports. */
export function bindBlobBucket(bucket: BlobBucketSync | null): void {
  seated = bucket;
  bindBlobWriter(bucket === null ? null : writerOver(bucket));
  bindBlobReader(bucket === null ? null : (sha256) => bucket.getSync(blobKeyOf(sha256)));
}

function writerOver(bucket: BlobBucketSync): BlobWriter {
  return (bytes, mime) => {
    try {
      return bucket.putSync(bytes, mime);
    } catch (error) {
      // The stamping site keeps the text inline; the log says why.
      fail("blob bucket refused a put", error);
      throw error;
    }
  };
}

/** Null while no bucket is seated, for a hash the bucket does not hold, and for bytes that no longer match it. */
export function readBlobSync(sha256: string): BlobBody | null {
  if (seated === null) return null;
  const key = blobKeyOf(sha256);
  const bytes = seated.getSync(key);
  if (bytes === null) return null;
  return { bytes, mime: seated.headSync(key)?.mime ?? blobMimeOf(bytes) };
}
