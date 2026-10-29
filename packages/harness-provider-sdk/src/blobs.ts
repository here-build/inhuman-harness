/**
 * Read seam for stored blobs. The kernel's blob bucket belongs to the daemon;
 * code that needs a blob's bytes (a provider projecting a wire, a recall tool)
 * reads them through here and never imports the store. Keys are content hashes,
 * so there is no session or id to pass: a hash a document names is the whole address.
 */

/** Bytes of one stored blob, or null when the hash is unknown or unreadable. */
export type BlobReader = (sha256: string) => Uint8Array | null;

let reader: BlobReader | null = null;

/** The host that owns the bucket binds it once at boot. `null` unbinds. */
export function bindBlobReader(read: BlobReader | null): void {
  reader = read;
}

/** Null while nothing is bound, so a caller falls back to the head the document kept. */
export function readBlob(sha256: string): Uint8Array | null {
  return reader === null ? null : reader(sha256);
}
