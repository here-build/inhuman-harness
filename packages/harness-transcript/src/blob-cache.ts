/**
 * Blob text for the tape. The document names a large body by hash and keeps its
 * head; a file mutation's prior text is the first such body. The daemon serves
 * the rest over `blob/get`. One cache serves the page, seated by the dial's
 * context over the open session's port.
 *
 * A peek is a MobX read keyed by hash, so a tape computed that peeked a blob
 * recomputes when that text lands, as it does when the document changes, and
 * no other computed does.
 */
import type { BlobPeek } from "@inhuman.tools/harness-model";
import { type BlobCache, type BlobRequest, createBlobCache } from "@inhuman.tools/harness-peer";
import { observable, runInAction } from "mobx";

/** Bumped per landing of a hash, so a re-landing after an eviction is a change too. */
const landed = observable.map<string, number>([], { deep: false });
/** Observable, so a tape that computed before a dial seated its cache recomputes after. */
const seat = observable.box<BlobCache | null>(null, { deep: false });

function land(sha256: string): void {
  runInAction(() => {
    landed.set(sha256, (landed.get(sha256) ?? 0) + 1);
  });
}

const view: BlobPeek = {
  peek(sha256) {
    const cache = seat.get();
    if (cache === null) return null;
    landed.get(sha256);
    return cache.peek(sha256);
  },
  want(sha256) {
    seat.get()?.want(sha256);
  },
};

/**
 * Seat a cache over `request`, the open session's JSON-RPC call; null clears the seat. What the previous cache
 * held goes with it. The release it returns clears the seat only if it still holds this cache.
 */
export function bindBlobCache(request: BlobRequest | null): () => void {
  const cache = request === null ? null : createBlobCache(request, land);
  runInAction(() => {
    seat.set(cache);
  });
  return () => {
    runInAction(() => {
      if (seat.get() === cache) seat.set(null);
    });
  };
}

/** The seated cache as the tape reads it. Peeks null and wants nothing until a dial seats one. */
export function blobs(): BlobPeek {
  return view;
}
