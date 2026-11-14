/**
 * Read seam for stored blobs. The kernel's blob bucket belongs to the daemon;
 * code that needs a blob's bytes (a provider projecting a wire, a recall tool)
 * reads them through here and never imports the store. Keys are content hashes,
 * so there is no session or id to pass: a hash a document names is the whole address.
 */
import { AsyncLocalStorage } from "node:async_hooks";

/** Bytes of one stored blob, or null when the hash is unknown or unreadable. */
export type BlobReader = (sha256: string) => Uint8Array | null;

let reader: BlobReader | null = null;
const readerContext = new AsyncLocalStorage<BlobReader>();

/** The host that owns the bucket binds it once at boot. `null` unbinds. */
export function bindBlobReader(read: BlobReader | null): void {
  reader = read;
}

/** Binds a reader scoped to the current async execution context (used by multi-kernel hosts). */
export function runWithBlobReader<T>(read: BlobReader, fn: () => T): T {
  return readerContext.run(read, fn);
}

/** Null while nothing is bound, so a caller falls back to the head the document kept. */
export function readBlob(sha256: string): Uint8Array | null {
  const active = readerContext.getStore() ?? reader;
  return active === null ? null : active(sha256);
}
