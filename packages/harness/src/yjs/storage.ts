/**
 * Sole image writer for a daemon root. Flush captures one update and
 * appends it; success is that append plus fsync, not a local mutation.
 * The file is an update log, so a later flush does not rewrite the prefix.
 * `read` joins a length-prefixed log, or one bare update from before that framing. A log that
 * is much larger than the joined snapshot is replaced once, after the join,
 * so the next open does not replay it. A flush that would grow the log past
 * {@link COMPACT_RATIO}× the last snapshot writes a fresh snapshot instead,
 * so the file stays within that bound without a rewrite per flush. A flush
 * that is `force`d writes the snapshot whatever the log's size: the vacuum of
 * a stored session shrinks the live document, and only a snapshot drops the
 * log's prefix that still holds what the vacuum moved out.
 */
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";

import { trace } from "@inhuman.tools/harness-diagnostics";
import * as Y from "yjs";

import {
  documentImageSegments,
  encodeDocUpdate,
  type DocumentCheckpoint,
  type DocumentKey,
  type DurableReceipt,
  type FlushResult,
} from "@/protocol/document";

import { encodeLogEntry, readUpdateLog } from "./update-log.js";

export type ImageFlushRequest = {
  readonly checkpoint: DocumentCheckpoint;
  readonly image: Uint8Array;
  /** Whole-document update, a superset of `image`. Called only to compact. */
  readonly snapshot?: () => Uint8Array;
  /**
   * Replace the file with one snapshot instead of appending `image`, whatever the log's size. Honored only when
   * `snapshot` is given; without it the image is appended as usual.
   */
  readonly force?: boolean;
  readonly runtimeGeneration: number;
  readonly connectionEpoch: number;
};

const COMPACT_RATIO = 2;
const COMPACT_FLOOR_BYTES = 1 << 20;

/** File bytes vs the last whole snapshot in it. */
type LogSize = { logBytes: number; snapshotBytes: number };

export function documentImagePath(root: string, key: DocumentKey): string {
  return join(root, ...documentImageSegments(key.kind, key.id));
}

function slotOf(key: DocumentKey): string {
  return `${key.kind}\0${key.id}`;
}

function yieldMacrotask(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/**
 * Create the file if it is missing, append one log entry, then fsync.
 * A crash before the fsync leaves the entry out of the durable prefix;
 * the next flush encodes it again from the state vector.
 */
async function appendLogEntry(path: string, update: Uint8Array): Promise<number> {
  await mkdir(dirname(path), { recursive: true });
  const entry = encodeLogEntry(update);
  const handle = await open(path, "a", 0o600);
  try {
    await handle.appendFile(entry);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return entry.byteLength;
}

export class DocumentImageStore {
  readonly #root: string;
  readonly #writes = new Map<string, Promise<void>>();
  readonly #sizes = new Map<string, LogSize>();

  constructor(root: string) {
    this.#root = root;
  }

  get root(): string {
    return this.#root;
  }

  pathFor(key: DocumentKey): string {
    return documentImagePath(this.#root, key);
  }

  /** The merged document update, or undefined when the file is missing. */
  async read(key: DocumentKey): Promise<Uint8Array | undefined> {
    let bytes: Buffer;
    try {
      bytes = await readFile(this.pathFor(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const updates = readUpdateLog(bytes);
    if (updates == null || updates.length === 0) return undefined;
    const doc = new Y.Doc();
    try {
      for (let index = 0; index < updates.length; index += 1) {
        const update = updates[index];
        if (update == null) continue;
        Y.applyUpdate(doc, update);
        // One long replay used to freeze the process: the session socket
        // never opened, and the client gave up at the sync timeout.
        if ((index & 31) === 31) await yieldMacrotask();
      }
      const merged = Y.encodeStateAsUpdate(doc);
      this.#sizes.set(slotOf(key), { logBytes: bytes.byteLength, snapshotBytes: merged.byteLength });
      if (updates.length > 1 && bytes.byteLength > merged.byteLength) {
        await this.#compactSnapshot(key, merged);
      }
      return merged;
    } finally {
      doc.destroy();
    }
  }

  /**
   * The joined snapshot replaces a bloated log. A flush already in flight
   * owns the tail, so this does not race it.
   */
  async #compactSnapshot(key: DocumentKey, merged: Uint8Array): Promise<void> {
    const slot = slotOf(key);
    if (this.#writes.has(slot)) return;
    const run = this.#writeSnapshot(key, merged);
    const tracked = run.then(
      () => undefined,
      () => undefined,
    );
    this.#writes.set(slot, tracked);
    void tracked.then(() => {
      if (this.#writes.get(slot) === tracked) this.#writes.delete(slot);
      return undefined;
    });
    try {
      await run;
    } catch (error) {
      trace(
        "harness-yjs-server:storage",
        `compact failed ${key.kind} ${key.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async #writeSnapshot(key: DocumentKey, merged: Uint8Array): Promise<void> {
    const path = this.pathFor(key);
    const tmp = `${path}.${randomUUID()}.tmp`;
    await mkdir(dirname(path), { recursive: true });
    const entry = encodeLogEntry(merged);
    const handle = await open(tmp, "w", 0o600);
    try {
      await handle.writeFile(entry);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, path);
    this.#sizes.set(slotOf(key), { logBytes: entry.byteLength, snapshotBytes: merged.byteLength });
  }

  #outgrows(key: DocumentKey, image: Uint8Array): boolean {
    const size = this.#sizes.get(slotOf(key));
    if (size == null) return false;
    const next = size.logBytes + image.byteLength;
    return next > COMPACT_FLOOR_BYTES && next > COMPACT_RATIO * size.snapshotBytes;
  }

  /**
   * Append the captured update. The receipt covers that prefix only after
   * the append is durable. A local mutation is not success.
   */
  async flush(request: ImageFlushRequest): Promise<FlushResult> {
    const captured: ImageFlushRequest = {
      checkpoint: request.checkpoint,
      image: new Uint8Array(request.image),
      snapshot: request.snapshot,
      force: request.force,
      runtimeGeneration: request.runtimeGeneration,
      connectionEpoch: request.connectionEpoch,
    };
    const slot = slotOf(captured.checkpoint.key);
    const previous = this.#writes.get(slot);
    const persist = (): Promise<FlushResult> => this.#persist(captured);
    const run = previous == null ? persist() : previous.then(persist, persist);
    const tracked = run.then(
      () => undefined,
      () => undefined,
    );
    this.#writes.set(slot, tracked);
    void tracked.then(() => {
      if (this.#writes.get(slot) === tracked) this.#writes.delete(slot);
      return undefined;
    });
    return run;
  }

  async #persist(request: ImageFlushRequest): Promise<FlushResult> {
    const { checkpoint, image, snapshot, force, runtimeGeneration, connectionEpoch } = request;
    const key = checkpoint.key;
    try {
      if (snapshot != null && (force === true || this.#outgrows(key, image))) {
        await this.#writeSnapshot(key, snapshot());
      } else {
        const entryBytes = await appendLogEntry(this.pathFor(key), image);
        const size = this.#sizes.get(slotOf(key));
        if (size == null) this.#sizes.set(slotOf(key), { logBytes: entryBytes, snapshotBytes: image.byteLength });
        else size.logBytes += entryBytes;
      }
    } catch (error) {
      trace(
        "harness-yjs-server:storage",
        `write failed ${checkpoint.key.kind} ${checkpoint.key.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { ok: false, reason: "storage-failed" };
    }
    const receipt: DurableReceipt = {
      key: checkpoint.key,
      serverEpoch: checkpoint.serverEpoch,
      runtimeGeneration,
      connectionEpoch,
      revision: checkpoint.revision,
      prefix: encodeDocUpdate(image),
    };
    return { ok: true, receipt };
  }
}
