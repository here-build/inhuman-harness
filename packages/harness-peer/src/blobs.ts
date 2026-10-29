/**
 * Blob text for a shell. The document names a large body by hash and keeps its
 * head; the daemon serves the rest over `blob/get`. A shell paints
 * synchronously, so it `peek`s the cache, paints without the text on a miss,
 * and `want`s it. `onArrive` says the text landed and the shell repaints. A
 * blob's bytes never change, so a text that landed stays valid; only memory
 * bounds the cache.
 */
import { blobGetOutput } from "@inhuman.tools/harness-contract";
import { SHA256_HEX, type BlobPeek } from "@inhuman.tools/harness-model";

/** Text held at once, in UTF-16 code units: the unit `BLOB_INLINE_MAX_CHARS` counts in. */
export const BLOB_CACHE_MAX_CHARS = 64 * 1024 * 1024;
/** How long a failed fetch is remembered, so a missing blob does not spin. */
export const BLOB_FAILURE_MS = 30_000;
/** Failures remembered at once; the oldest is forgotten first. */
const FAILURE_MEMORY = 1024;

/** The session plane's JSON-RPC call. */
export type BlobRequest = (method: string, params: unknown) => Promise<unknown>;

export type BlobCache = BlobPeek & {
  /** True once the daemon answered for this hash, a blob that is not text included. */
  has(sha256: string): boolean;
  /** Blobs held, the ones `peek` answers null for included. */
  readonly size: number;
  /** Drops what is held and what failed. A fetch already on the wire still lands. */
  clear(): void;
};

export type BlobCacheOptions = {
  /** Text to hold before the least recently used goes. Default {@link BLOB_CACHE_MAX_CHARS}. */
  readonly maxChars?: number;
  /** Default {@link BLOB_FAILURE_MS}. */
  readonly failureMs?: number;
  readonly now?: () => number;
};

/** What the cache knows of a blob. No text means the daemon sent bytes, or the text is over the whole budget. */
type Held = { readonly text: string | null; readonly chars: number };

/**
 * `request` is the session socket's `request`. `onArrive` runs after each
 * answer from the daemon, with the hash that landed, so a shell can repaint
 * what painted without it.
 */
export function createBlobCache(
  request: BlobRequest,
  onArrive: (sha256: string) => void,
  options: BlobCacheOptions = {},
): BlobCache {
  const maxChars = options.maxChars ?? BLOB_CACHE_MAX_CHARS;
  const failureMs = options.failureMs ?? BLOB_FAILURE_MS;
  const now = options.now ?? Date.now;
  // Least recently used first. A Map iterates in insertion order and a touch re-inserts.
  const held = new Map<string, Held>();
  const inflight = new Set<string>();
  const failed = new Map<string, number>();
  let chars = 0;

  const touch = (sha256: string, entry: Held): void => {
    held.delete(sha256);
    held.set(sha256, entry);
  };

  const keep = (sha256: string, entry: Held): void => {
    const previous = held.get(sha256);
    if (previous !== undefined) chars -= previous.chars;
    held.delete(sha256);
    held.set(sha256, entry);
    chars += entry.chars;
    for (const [oldest, old] of held) {
      if (chars <= maxChars || oldest === sha256) break;
      held.delete(oldest);
      chars -= old.chars;
    }
  };

  const fail = (sha256: string): void => {
    failed.delete(sha256);
    failed.set(sha256, now());
    if (failed.size > FAILURE_MEMORY) {
      const oldest = failed.keys().next();
      if (oldest.done !== true) failed.delete(oldest.value);
    }
  };

  const land = (sha256: string, result: unknown): void => {
    const answer = blobGetOutput.safeParse(result);
    if (!answer.success || answer.data.sha256 !== sha256) {
      fail(sha256);
      return;
    }
    const { text } = answer.data;
    failed.delete(sha256);
    keep(sha256, text === null || text.length > maxChars ? { text: null, chars: 0 } : { text, chars: text.length });
    try {
      onArrive(sha256);
    } catch {
      // A repaint hook that throws must not poison the cache; the text has landed.
    }
  };

  return {
    peek(sha256) {
      const entry = held.get(sha256);
      if (entry === undefined) return null;
      touch(sha256, entry);
      return entry.text;
    },
    want(sha256) {
      if (!SHA256_HEX.test(sha256)) return;
      const entry = held.get(sha256);
      if (entry !== undefined) {
        touch(sha256, entry);
        return;
      }
      if (inflight.has(sha256)) return;
      const failedAt = failed.get(sha256);
      if (failedAt !== undefined) {
        if (now() - failedAt < failureMs) return;
        failed.delete(sha256);
      }
      inflight.add(sha256);
      // The request goes out now; a throw from it reads as a rejection.
      void (async () => {
        let result: unknown;
        try {
          result = await request("blob/get", { sha256 });
        } catch {
          inflight.delete(sha256);
          fail(sha256);
          return;
        }
        inflight.delete(sha256);
        land(sha256, result);
      })();
    },
    has: (sha256) => held.has(sha256),
    get size() {
      return held.size;
    },
    clear() {
      held.clear();
      failed.clear();
      chars = 0;
    },
  };
}
