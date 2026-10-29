import * as Y from "yjs";

/**
 * Where a client keeps a room's document between launches, so a reconnect
 * downloads only what the daemon has that the cache lacks.
 *
 * A room is a log of Yjs updates under one key. `load` returns them in the order they were
 * appended; `append` adds one; `replace` swaps the whole log for one merged state (compaction);
 * `drop` forgets the key. Writes are fire-and-forget; the store orders them.
 */
export interface DocCache {
  load(key: string): Promise<readonly Uint8Array[] | null>;
  append(key: string, update: Uint8Array): void;
  replace(key: string, state: Uint8Array): void;
  drop(key: string): void;
}

/** Transaction origin of cached state going into a doc; it is never written back. */
export const CACHE_ORIGIN = Symbol("doc-cache");

/** Past this many records, or this much beyond the base state, the log is rewritten as one. */
export const COMPACT_RECORDS = 200;
export const COMPACT_MIN_BYTES = 4 * 1024 * 1024;
/** On release, a smaller tail is worth a rewrite too. */
export const COMPACT_RELEASE_BYTES = 256 * 1024;
export const COMPACT_RELEASE_RECORDS = 32;

/** The daemon, the room and its params name one cache entry; a different daemon never shares it. */
export function cacheKey(origin: string, room: string, params: Readonly<Record<string, string>>): string {
  const name =
    room === "project"
      ? `project:${params.path ?? ""}`
      : room === "session"
        ? `session:${params.sessionId ?? ""}`
        : room;
  return `${origin}|${name}`;
}

/** True when `doc` has a client clock the server's state vector lacks: the cache is not a subset of the daemon. */
export function holdsBeyond(doc: Y.Doc, serverVector: Uint8Array): boolean {
  const server = Y.decodeStateVector(serverVector);
  for (const [client, clock] of Y.decodeStateVector(Y.encodeStateVector(doc))) {
    if (clock > (server.get(client) ?? 0)) return true;
  }
  return false;
}

function readVarUint(arr: Uint8Array, start: number): [number, number] {
  let value = 0;
  let shift = 0;
  let pos = start;
  for (;;) {
    const byte = arr[pos++];
    if (byte === undefined) throw new Error("truncated varint");
    value += (byte & 0x7f) * 2 ** shift;
    if (byte < 0x80) return [value, pos];
    shift += 7;
  }
}

/** y-websocket's handler: (encoder, decoder, provider, emitSynced, messageType). */
type Guarded<Args extends [unknown, unknown, ...unknown[]]> = { messageHandlers: Array<(...args: Args) => void> };

const SYNC = 0;
const STEP1 = 0;

/**
 * Stand between y-websocket and a cached doc.
 *
 * The daemon opens every seat with its own STEP1 (its state vector). Until that arrives and
 * the doc proves to be a subset of it, nothing else syncs: a STEP2 or update first means a daemon
 * that cannot be checked. A doc that holds more than the daemon is stale (the daemon's
 * document was replaced or trimmed); `onStale` fires and the room must start over empty.
 * The client never answers a STEP1, so cached state is never pushed to the daemon.
 *
 * `onStale(false)` is a refusal before the first sync; `onStale(true)` a later reconnect
 * that found the daemon behind the doc (the doc stays, the cache is the caller's to drop).
 */
export function guardProvider<Args extends [unknown, unknown, ...unknown[]]>(
  provider: Guarded<Args>,
  doc: Y.Doc,
  holdsCache: boolean,
  isSynced: () => boolean,
  onStale: (afterSync: boolean) => void,
): void {
  const sync = provider.messageHandlers[SYNC];
  if (sync == null) return;
  let verified = !holdsCache;
  let refused = false;
  provider.messageHandlers[SYNC] = (...args) => {
    if (refused) return;
    const { arr, pos } = args[1] as { arr: Uint8Array; pos: number };
    const [kind, afterKind] = readVarUint(arr, pos);
    if (kind === STEP1) {
      const [length, start] = readVarUint(arr, afterKind);
      if (holdsBeyond(doc, arr.subarray(start, start + length))) {
        refused = true;
        onStale(isSynced());
        return;
      }
      verified = true;
      return;
    }
    if (!verified) {
      refused = true;
      onStale(false);
      return;
    }
    sync(...args);
  };
}

/** What a room asks of its cache while it lives: write behind, compact, release. */
export type Writer = {
  /** The first sync finished: from here appends count against compaction. */
  synced: () => void;
  /** Stop writing and, if the log has a long tail, rewrite it as one. */
  release: (compact: boolean) => void;
  /** Stop writing without compacting; the key was dropped. */
  abandon: () => void;
};

/**
 * Only what `source` (the provider) delivered is kept. A doc may write locally while it is
 * attached (the first write of a plexus, say); the daemon never takes those, so a cache that
 * kept them would hold a clock the daemon lacks and be thrown away on every launch.
 */
export function writeBehind(
  cache: DocCache,
  key: string,
  doc: Y.Doc,
  loaded: readonly Uint8Array[],
  source: unknown,
): Writer {
  let records = loaded.length;
  let base = loaded.reduce((sum, update) => sum + update.byteLength, 0);
  const largest = loaded.reduce((most, update) => Math.max(most, update.byteLength), 0);
  let extra = 0;
  let live = true;
  let settled = false;
  const compact = (): void => {
    // Everything but this doc's own writes: a state vector already past them asks for none.
    const state = Y.encodeStateAsUpdate(doc, Y.encodeStateVector(new Map([[doc.clientID, 2 ** 32]])));
    cache.replace(key, state);
    records = 1;
    base = state.byteLength;
    extra = 0;
  };
  const onUpdate = (update: Uint8Array, origin: unknown): void => {
    if (!live || origin !== source) return;
    cache.append(key, update);
    records += 1;
    if (!settled) {
      base += update.byteLength;
      return;
    }
    extra += update.byteLength;
    if (records > COMPACT_RECORDS || extra > Math.max(COMPACT_MIN_BYTES, base / 2)) compact();
  };
  doc.on("update", onUpdate);
  return {
    synced: () => {
      settled = true;
      // Two rooms on one key (a stale attach and its successor) each log the full sync; merge the copies.
      if (live && (records > COMPACT_RELEASE_RECORDS || base > largest * 1.25 + COMPACT_RELEASE_BYTES)) compact();
    },
    release: (rewrite) => {
      if (!live) return;
      live = false;
      doc.off("update", onUpdate);
      if (rewrite && settled && (extra > COMPACT_RELEASE_BYTES || records > COMPACT_RELEASE_RECORDS)) compact();
    },
    abandon: () => {
      live = false;
      doc.off("update", onUpdate);
    },
  };
}
