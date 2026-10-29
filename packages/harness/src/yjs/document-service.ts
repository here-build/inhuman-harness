/**
 * Registry plus the sole image writer. Flush captures the prefix before
 * the async write; success is the receipt, not a local mutation. Dirty
 * replicas stay pinned inside the memory budgets.
 */
import * as Y from "yjs";

import {
  checkpointOf,
  type DocumentCheckpoint,
  type DocumentKey,
  type DocumentKind,
  type FlushResult,
  type InventoryCheckpoint,
  type InventoryError,
  type InventoryListQuery,
  type InventoryPage,
} from "@/protocol/document";

import { DocumentRegistry, documentGuid, type DocumentRef, type InventoryWatch } from "./registry/index.js";
import { DocumentImageStore } from "./storage.js";

export type MemoryBudgets = {
  readonly perDocumentDirty: number;
  readonly aggregateDirty: number;
  readonly aggregateResident: number;
  readonly pinCount: number;
};

export type DocumentServiceOptions = {
  readonly root: string;
  readonly serverEpoch?: number;
  readonly pageSize?: number;
  readonly watchBound?: number;
  readonly runtimeGeneration?: number;
  readonly connectionEpoch?: number;
  readonly budgets?: Partial<MemoryBudgets>;
};

export type MemoryState = {
  readonly dirtyBytes: number;
  readonly residentBytes: number;
  readonly pinCount: number;
  readonly writeAdmission: "open" | "stopped";
};

export type OpenResult =
  | { readonly ok: true; readonly ref: DocumentRef }
  | {
      readonly ok: false;
      readonly reason: "not-found" | "overload" | "corrupt";
    };

export type CreateResult =
  | { readonly ok: true; readonly ref: DocumentRef }
  | { readonly ok: false; readonly reason: "overload" | "storage-failed" };

export type ApplyResult = { readonly ok: true } | { readonly ok: false; readonly reason: "overload" | "disconnected" };

const UNBOUNDED = Number.MAX_SAFE_INTEGER;
/** Unchanged state encodes as `[0, 0]`, not a 0-length buffer. */
const EMPTY_UPDATE = new Uint8Array([0, 0]);

type Replica = {
  readonly key: DocumentKey;
  readonly doc: Y.Doc;
  readonly onUpdate: (update: Uint8Array) => void;
  consumerPins: number;
  revision: number;
  /**
   * Updates since the last durable flush, as Yjs emitted them. Each carries
   * only its own deletions. `encodeStateAsUpdate(doc, sv)` would carry the
   * whole delete set on every flush and grow the log by it each time.
   */
  pending: Uint8Array[];
  dirtyBytes: number;
  residentBytes: number;
};

function keyId(key: DocumentKey): string {
  return `${key.kind}\0${key.id}`;
}

/** Unchanged state encodes as `[0, 0]`, not a 0-length buffer. */
function dirtySuffixBytes(update: Uint8Array): number {
  if (update.byteLength === 0) return 0;
  if (update.byteLength === 2 && update[0] === 0 && update[1] === 0) return 0;
  return update.byteLength;
}

function toRef(replica: Replica): DocumentRef {
  return { key: replica.key, doc: replica.doc, revision: replica.revision };
}

export class DocumentService {
  readonly #registry: DocumentRegistry;
  readonly #store: DocumentImageStore;
  readonly #budgets: MemoryBudgets;
  readonly #runtimeGeneration: number;
  readonly #connectionEpoch: number;
  readonly #replicas = new Map<string, Replica>();
  readonly #ops = new Map<string, Promise<void>>();
  #dirtyTotal = 0;
  #residentTotal = 0;
  #writeAdmission: "open" | "stopped" = "open";

  constructor(options: DocumentServiceOptions) {
    this.#registry = new DocumentRegistry({
      root: options.root,
      serverEpoch: options.serverEpoch,
      pageSize: options.pageSize,
      watchBound: options.watchBound,
    });
    this.#store = new DocumentImageStore(options.root);
    this.#runtimeGeneration = options.runtimeGeneration ?? 0;
    this.#connectionEpoch = options.connectionEpoch ?? 0;
    this.#budgets = {
      perDocumentDirty: options.budgets?.perDocumentDirty ?? UNBOUNDED,
      aggregateDirty: options.budgets?.aggregateDirty ?? UNBOUNDED,
      aggregateResident: options.budgets?.aggregateResident ?? UNBOUNDED,
      pinCount: options.budgets?.pinCount ?? UNBOUNDED,
    };
  }

  get root(): string {
    return this.#registry.root;
  }

  get serverEpoch(): number {
    return this.#registry.serverEpoch;
  }

  memory(): MemoryState {
    return {
      dirtyBytes: this.#dirtyTotal,
      residentBytes: this.#residentTotal,
      pinCount: this.#replicas.size,
      writeAdmission: this.#writeAdmission,
    };
  }

  /** Synchronous lookup. Never disk or network I/O, never creates. */
  getLoaded(key: DocumentKey): DocumentRef | undefined {
    const replica = this.#replicas.get(keyId(key));
    return replica == null ? undefined : toRef(replica);
  }

  /** Memory-only intern table. Never disk or network I/O, never creates. */
  loaded(): readonly DocumentRef[] {
    return [...this.#replicas.values()].map(toRef);
  }

  inventoryErrors(): readonly InventoryError[] {
    return this.#registry.inventoryErrors();
  }

  list(query: InventoryListQuery): Promise<InventoryPage> {
    return this.#registry.list(query);
  }

  watchChanges(kind: DocumentKind, checkpoint: InventoryCheckpoint): InventoryWatch {
    return this.#registry.watchChanges(kind, checkpoint);
  }

  checkpoint(key: DocumentKey): DocumentCheckpoint | undefined {
    const replica = this.#replicas.get(keyId(key));
    if (replica == null) return undefined;
    return checkpointOf(replica.doc, replica.key, this.#registry.serverEpoch, replica.revision + 1);
  }

  async openExisting(key: DocumentKey): Promise<OpenResult> {
    return this.#locked(key, () => this.#openExistingNow(key));
  }

  async create(key: DocumentKey, initial?: Uint8Array): Promise<CreateResult> {
    return this.#locked(key, () => this.#createNow(key, initial));
  }

  /**
   * Persist the live prefix captured at this call. Later mutations are not
   * in the receipt. A failed write stays dirty and is not success.
   *
   * `force` replaces the stored image with one snapshot of the live document, even when nothing is
   * pending: after the vacuum of a stored session the log's prefix is the weight to drop.
   */
  async flush(
    key: DocumentKey,
    checkpoint: DocumentCheckpoint,
    options?: {
      readonly runtimeGeneration?: number;
      readonly connectionEpoch?: number;
      readonly force?: boolean;
    },
  ): Promise<FlushResult> {
    return this.#locked(key, () => this.#flushNow(key, checkpoint, options));
  }

  applyUpdate(key: DocumentKey, update: Uint8Array, origin?: unknown): ApplyResult {
    const replica = this.#replicas.get(keyId(key));
    if (replica == null) return { ok: false, reason: "disconnected" };
    if (this.#writeAdmission === "stopped") {
      return { ok: false, reason: "overload" };
    }
    const incoming = update.byteLength;
    if (replica.dirtyBytes + incoming > this.#budgets.perDocumentDirty) {
      return { ok: false, reason: "overload" };
    }
    if (this.#dirtyTotal + incoming > this.#budgets.aggregateDirty) {
      return { ok: false, reason: "overload" };
    }
    Y.applyUpdate(replica.doc, update, origin);
    return { ok: true };
  }

  release(key: DocumentKey): void {
    const replica = this.#replicas.get(keyId(key));
    if (replica == null) return;
    replica.consumerPins -= 1;
    if (replica.consumerPins > 0) return;
    // Unsaved suffix pins the replica; dropping it would hide dirty state.
    if (replica.dirtyBytes > 0) return;
    this.#evict(replica);
  }

  async #openExistingNow(key: DocumentKey): Promise<OpenResult> {
    const existing = this.#replicas.get(keyId(key));
    if (existing != null) {
      existing.consumerPins += 1;
      return { ok: true, ref: toRef(existing) };
    }
    if (this.#replicas.size >= this.#budgets.pinCount) {
      return { ok: false, reason: "overload" };
    }
    let image: Uint8Array | undefined;
    try {
      image = await this.#store.read(key);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EACCES") {
        return { ok: false, reason: "corrupt" };
      }
      throw error;
    }
    if (image == null) return { ok: false, reason: "not-found" };
    return this.#loadImage(key, image);
  }

  async #createNow(key: DocumentKey, initial: Uint8Array | undefined): Promise<CreateResult> {
    const existing = this.#replicas.get(keyId(key));
    if (existing != null) {
      existing.consumerPins += 1;
      return { ok: true, ref: toRef(existing) };
    }
    if (this.#writeAdmission === "stopped") {
      return { ok: false, reason: "overload" };
    }
    if (this.#replicas.size >= this.#budgets.pinCount) {
      return { ok: false, reason: "overload" };
    }
    const stored = await this.#store.read(key);
    if (stored != null) {
      const opened = this.#loadImage(key, stored);
      if (opened.ok) return { ok: true, ref: opened.ref };
      if (opened.reason === "overload") {
        return { ok: false, reason: "overload" };
      }
      return { ok: false, reason: "storage-failed" };
    }
    const doc = new Y.Doc({ guid: documentGuid(key) });
    if (initial != null && initial.byteLength > 0) {
      try {
        Y.applyUpdate(doc, initial);
      } catch {
        doc.destroy();
        return { ok: false, reason: "storage-failed" };
      }
    }
    if (!this.#fitsResident(doc)) {
      doc.destroy();
      return { ok: false, reason: "overload" };
    }
    const checkpoint = checkpointOf(doc, key, this.#registry.serverEpoch, 1);
    const image = Y.encodeStateAsUpdate(doc);
    const result = await this.#store.flush({
      checkpoint,
      image,
      runtimeGeneration: this.#runtimeGeneration,
      connectionEpoch: this.#connectionEpoch,
    });
    if (!result.ok) {
      doc.destroy();
      return { ok: false, reason: "storage-failed" };
    }
    const replica = this.#admit(key, doc, 1);
    if (replica == null) {
      doc.destroy();
      return { ok: false, reason: "overload" };
    }
    return { ok: true, ref: toRef(replica) };
  }

  #loadImage(key: DocumentKey, image: Uint8Array): OpenResult {
    if (image.byteLength === 0) return { ok: false, reason: "corrupt" };
    const doc = new Y.Doc({ guid: documentGuid(key) });
    try {
      Y.applyUpdate(doc, image);
    } catch {
      doc.destroy();
      return { ok: false, reason: "corrupt" };
    }
    const replica = this.#admit(key, doc, 0);
    if (replica == null) {
      doc.destroy();
      return { ok: false, reason: "overload" };
    }
    return { ok: true, ref: toRef(replica) };
  }

  async #flushNow(
    key: DocumentKey,
    checkpoint: DocumentCheckpoint,
    options:
      | {
          readonly runtimeGeneration?: number;
          readonly connectionEpoch?: number;
          readonly force?: boolean;
        }
      | undefined,
  ): Promise<FlushResult> {
    const replica = this.#replicas.get(keyId(key));
    if (replica == null) return { ok: false, reason: "disconnected" };
    const inFlight = replica.pending;
    const flightBytes = replica.dirtyBytes;
    const force = options?.force === true;
    if (inFlight.length === 0 && !force) {
      return {
        ok: true,
        receipt: {
          key,
          serverEpoch: checkpoint.serverEpoch,
          runtimeGeneration: options?.runtimeGeneration ?? this.#runtimeGeneration,
          connectionEpoch: options?.connectionEpoch ?? this.#connectionEpoch,
          revision: checkpoint.revision,
          prefix: EMPTY_UPDATE,
        },
      };
    }
    const image =
      inFlight.length === 0 ? EMPTY_UPDATE : inFlight.length === 1 ? inFlight[0]! : Y.mergeUpdates(inFlight);
    replica.pending = [];
    const result = await this.#store.flush({
      checkpoint,
      image,
      snapshot: () => Y.encodeStateAsUpdate(replica.doc),
      ...(force ? { force } : {}),
      runtimeGeneration: options?.runtimeGeneration ?? this.#runtimeGeneration,
      connectionEpoch: options?.connectionEpoch ?? this.#connectionEpoch,
    });
    if (!result.ok) {
      replica.pending = [...inFlight, ...replica.pending];
      return result;
    }
    replica.revision = checkpoint.revision;
    this.#settle(replica, flightBytes);
    this.#registry.upsertCatalog(key, checkpoint.revision);
    if (replica.consumerPins === 0 && replica.dirtyBytes === 0) {
      this.#evict(replica);
    }
    return result;
  }

  #admit(key: DocumentKey, doc: Y.Doc, revision: number): Replica | undefined {
    // Recheck after the read/flush await; per-key locks do not serialize budgets.
    if (this.#replicas.size >= this.#budgets.pinCount) return undefined;
    if (!this.#fitsResident(doc)) return undefined;
    return this.#adopt(key, doc, revision);
  }

  #adopt(key: DocumentKey, doc: Y.Doc, revision: number): Replica {
    this.#registry.intern(key, doc);
    const replica: Replica = {
      key,
      doc,
      consumerPins: 1,
      revision,
      pending: [],
      dirtyBytes: 0,
      residentBytes: 0,
      onUpdate: (update: Uint8Array) => {
        this.#noteUpdate(replica, update);
      },
    };
    this.#replicas.set(keyId(key), replica);
    doc.on("update", replica.onUpdate);
    replica.residentBytes = Y.encodeStateAsUpdate(doc).byteLength;
    this.#account(replica);
    if (revision > 0) this.#registry.upsertCatalog(key, revision);
    return replica;
  }

  #fitsResident(doc: Y.Doc): boolean {
    const resident = Y.encodeStateAsUpdate(doc).byteLength;
    return this.#residentTotal + resident <= this.#budgets.aggregateResident;
  }

  /** Grow the counters from the update Yjs just applied. No document encode. */
  #noteUpdate(replica: Replica, update: Uint8Array): void {
    const added = dirtySuffixBytes(update);
    if (added === 0) return;
    replica.pending.push(update);
    replica.residentBytes += added;
    replica.dirtyBytes += added;
    this.#residentTotal += added;
    this.#dirtyTotal += added;
    this.#writeAdmission = this.#dirtyTotal >= this.#budgets.aggregateDirty ? "stopped" : "open";
  }

  #account(replica: Replica): void {
    this.#residentTotal += replica.residentBytes;
    this.#dirtyTotal += replica.dirtyBytes;
    this.#admitWrites();
  }

  /** The flushed prefix is durable. Bytes that landed during the write stay pending. */
  #settle(replica: Replica, flushedBytes: number): void {
    replica.dirtyBytes -= flushedBytes;
    this.#dirtyTotal -= flushedBytes;
    this.#admitWrites();
  }

  #admitWrites(): void {
    this.#writeAdmission = this.#dirtyTotal >= this.#budgets.aggregateDirty ? "stopped" : "open";
  }

  #evict(replica: Replica): void {
    replica.doc.off("update", replica.onUpdate);
    this.#dirtyTotal -= replica.dirtyBytes;
    this.#residentTotal -= replica.residentBytes;
    this.#admitWrites();
    this.#replicas.delete(keyId(replica.key));
    this.#registry.release(replica.key);
    replica.doc.destroy();
  }

  async #locked<T>(key: DocumentKey, run: () => Promise<T>): Promise<T> {
    const id = keyId(key);
    const previous = this.#ops.get(id);
    const execute = previous == null ? run() : previous.then(run, run);
    const tracked = execute.then(
      () => undefined,
      () => undefined,
    );
    this.#ops.set(id, tracked);
    void tracked.then(() => {
      if (this.#ops.get(id) === tracked) this.#ops.delete(id);
      return undefined;
    });
    return execute;
  }
}
