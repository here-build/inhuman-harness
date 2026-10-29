/**
 * In-memory Y.Doc refs plus identity inventory. list() freezes a cut so
 * pagination does not see later creates; watchers get those as change/gap
 * events instead. getLoaded never touches disk.
 */
import { trace } from "@inhuman.tools/harness-diagnostics";
import type * as Y from "yjs";

import {
  documentKeysEqual,
  type DocumentKey,
  type DocumentKind,
  type InventoryCheckpoint,
  type InventoryEntry,
  type InventoryError,
  type InventoryListQuery,
  type InventoryPage,
  type InventoryWatchEvent,
} from "@/protocol/document";

import { documentImagePath, identifyStoredImage } from "./identity.js";
import { createFsImageSource, type ImageSource } from "./images.js";

export type DocumentRef = {
  readonly key: DocumentKey;
  readonly doc: Y.Doc;
  readonly revision: number;
};

export type DocumentRegistryOptions = {
  readonly root: string;
  readonly serverEpoch?: number;
  readonly pageSize?: number;
  readonly watchBound?: number;
};

type LoadedDoc = {
  readonly key: DocumentKey;
  readonly doc: Y.Doc;
  revision: number;
  pins: number;
};

type CutSnapshot = {
  readonly epoch: number;
  readonly kind: DocumentKind;
  readonly entries: readonly InventoryEntry[];
};

type Watcher = {
  readonly kind: DocumentKind;
  gapped: boolean;
  queue: InventoryWatchEvent[];
};

export type InventoryWatch = {
  pull(): InventoryWatchEvent[];
  close(): void;
};

function keyId(key: DocumentKey): string {
  return `${key.kind}\0${key.id}`;
}

export class DocumentRegistry {
  readonly root: string;
  readonly #images: ImageSource;
  readonly #pageSize: number;
  readonly #watchBound: number;
  #epoch: number;
  #nextCut = 1;
  readonly #loaded = new Map<string, LoadedDoc>();
  readonly #catalog = new Map<string, InventoryEntry>();
  readonly #errors = new Map<string, InventoryError>();
  readonly #cuts = new Map<number, CutSnapshot>();
  readonly #watchers = new Set<Watcher>();
  readonly #extracting = new Map<string, Promise<void>>();

  constructor(options: DocumentRegistryOptions) {
    this.root = options.root;
    this.#images = createFsImageSource(options.root);
    this.#pageSize = options.pageSize ?? 32;
    this.#watchBound = options.watchBound ?? 64;
    this.#epoch = options.serverEpoch ?? 1;
  }

  get serverEpoch(): number {
    return this.#epoch;
  }

  getLoaded(key: DocumentKey): DocumentRef | undefined {
    const loaded = this.#loaded.get(keyId(key));
    return loaded == null ? undefined : toRef(loaded);
  }

  intern(key: DocumentKey, doc: Y.Doc): DocumentRef {
    const id = keyId(key);
    const existing = this.#loaded.get(id);
    if (existing != null) {
      existing.pins += 1;
      return toRef(existing);
    }
    const loaded: LoadedDoc = { key, doc, revision: 0, pins: 1 };
    this.#loaded.set(id, loaded);
    this.#emitChange(key, loaded.revision);
    return toRef(loaded);
  }

  /** Successful persist upserts the catalog row and the live revision. */
  upsertCatalog(key: DocumentKey, durableRevision: number): void {
    const storagePath = documentImagePath(this.root, key.kind, key.id);
    const id = keyId(key);
    this.#catalog.set(id, { key, durableRevision, storagePath });
    this.#errors.delete(storagePath);
    const loaded = this.#loaded.get(id);
    if (loaded != null) loaded.revision = durableRevision;
    this.#emitChange(key, durableRevision);
  }

  release(key: DocumentKey): void {
    const id = keyId(key);
    const loaded = this.#loaded.get(id);
    if (loaded == null) return;
    loaded.pins -= 1;
    if (loaded.pins > 0) return;
    this.#loaded.delete(id);
  }

  inventoryErrors(): readonly InventoryError[] {
    return [...this.#errors.values()];
  }

  bumpServerEpoch(): void {
    this.#epoch += 1;
    this.#cuts.clear();
    for (const watcher of this.#watchers) {
      watcher.gapped = true;
      watcher.queue = [{ type: "gap", reason: "epoch-change", serverEpoch: this.#epoch }];
    }
  }

  watchChanges(kind: DocumentKind, checkpoint: InventoryCheckpoint): InventoryWatch {
    const watcher: Watcher = { kind, gapped: false, queue: [] };
    if (checkpoint.serverEpoch !== this.#epoch) {
      watcher.gapped = true;
      watcher.queue = [{ type: "gap", reason: "epoch-change", serverEpoch: this.#epoch }];
    } else if (!this.#cuts.has(checkpoint.cut)) {
      watcher.gapped = true;
      watcher.queue = [
        {
          type: "gap",
          reason: "missing-checkpoint",
          serverEpoch: this.#epoch,
        },
      ];
    }
    this.#watchers.add(watcher);
    return {
      pull: () => {
        const events = watcher.queue;
        watcher.queue = [];
        return events;
      },
      close: () => {
        this.#watchers.delete(watcher);
      },
    };
  }

  async list(query: InventoryListQuery): Promise<InventoryPage> {
    if (query.cursor == null) {
      const entries = await this.#snapshot(query.kind);
      const cut = this.#nextCut;
      this.#nextCut += 1;
      this.#cuts.set(cut, { epoch: this.#epoch, kind: query.kind, entries });
      return this.#page(cut, 0, entries);
    }
    const parsed = parseCursor(query.cursor);
    if (parsed == null) {
      return {
        entries: [],
        cursor: null,
        checkpoint: { serverEpoch: this.#epoch, cut: 0 },
      };
    }
    const snapshot = this.#cuts.get(parsed.cut);
    if (snapshot?.epoch !== this.#epoch || snapshot.kind !== query.kind) {
      return {
        entries: [],
        cursor: null,
        checkpoint: { serverEpoch: this.#epoch, cut: parsed.cut },
      };
    }
    return this.#page(parsed.cut, parsed.offset, snapshot.entries);
  }

  #page(cut: number, offset: number, entries: readonly InventoryEntry[]): InventoryPage {
    const slice = entries.slice(offset, offset + this.#pageSize);
    const next = offset + this.#pageSize;
    return {
      entries: slice,
      cursor: next < entries.length ? formatCursor(cut, next) : null,
      checkpoint: { serverEpoch: this.#epoch, cut },
    };
  }

  async #snapshot(kind: DocumentKind): Promise<readonly InventoryEntry[]> {
    const byId = new Map<string, InventoryEntry>();
    const seenPaths = new Set<string>();

    for (const loaded of this.#loaded.values()) {
      if (loaded.key.kind !== kind) continue;
      const entry = entryOf(this.root, loaded.key, loaded.revision);
      byId.set(loaded.key.id, entry);
      seenPaths.add(entry.storagePath);
    }

    const paths = new Set<string>();
    for (const entry of this.#catalog.values()) {
      if (entry.key.kind === kind) paths.add(entry.storagePath);
    }
    for (const storagePath of await this.#images.list(kind)) {
      paths.add(storagePath);
    }

    for (const storagePath of paths) {
      if (seenPaths.has(storagePath)) continue;
      await this.#extract(kind, storagePath);
      const cataloged = this.#catalogByPath(storagePath);
      if (cataloged == null || byId.has(cataloged.key.id)) continue;
      byId.set(cataloged.key.id, cataloged);
    }

    return [...byId.values()].sort((a, b) => a.key.id.localeCompare(b.key.id));
  }

  #catalogByPath(storagePath: string): InventoryEntry | undefined {
    for (const entry of this.#catalog.values()) {
      if (entry.storagePath === storagePath) return entry;
    }
    return undefined;
  }

  async #extract(kind: DocumentKind, storagePath: string): Promise<void> {
    const pending = this.#extracting.get(storagePath);
    if (pending != null) {
      await pending;
      return;
    }
    const run = this.#extractOne(kind, storagePath).finally(() => {
      this.#extracting.delete(storagePath);
    });
    this.#extracting.set(storagePath, run);
    await run;
  }

  async #extractOne(kind: DocumentKind, storagePath: string): Promise<void> {
    const previous = this.#catalogByPath(storagePath);
    const bytes = await this.#images.read(storagePath);
    if (bytes == null) {
      this.#dropCatalogPath(storagePath);
      this.#recordError(storagePath, "empty");
      return;
    }
    const decoded = identifyStoredImage(this.root, kind, storagePath, bytes);
    if (!decoded.ok) {
      this.#dropCatalogPath(storagePath);
      this.#recordError(storagePath, decoded.reason);
      return;
    }
    const key = { kind, id: decoded.id };
    const unchanged =
      previous?.key.kind === kind && previous.key.id === decoded.id && previous.storagePath === storagePath;
    this.#dropCatalogPath(storagePath);
    const entry: InventoryEntry = {
      key,
      durableRevision: unchanged ? previous.durableRevision : 0,
      storagePath,
    };
    this.#catalog.set(keyId(key), entry);
    this.#errors.delete(storagePath);
    if (!unchanged) this.#emitChange(key, entry.durableRevision);
  }

  #dropCatalogPath(storagePath: string): void {
    for (const [id, entry] of this.#catalog) {
      if (entry.storagePath === storagePath) this.#catalog.delete(id);
    }
  }

  #recordError(storagePath: string, reason: InventoryError["reason"]): void {
    this.#errors.set(storagePath, { storagePath, reason });
    trace("yjs-server:inventory", `${reason} ${storagePath}`);
  }

  #emitChange(key: DocumentKey, revision: number): void {
    const event: InventoryWatchEvent = { type: "change", key, revision };
    for (const watcher of this.#watchers) {
      if (watcher.kind !== key.kind || watcher.gapped) continue;
      coalesceChange(watcher.queue, event);
      if (watcher.queue.length > this.#watchBound) {
        watcher.gapped = true;
        watcher.queue = [{ type: "gap", reason: "overflow", serverEpoch: this.#epoch }];
      }
    }
  }
}

function toRef(loaded: LoadedDoc): DocumentRef {
  return { key: loaded.key, doc: loaded.doc, revision: loaded.revision };
}

function entryOf(root: string, key: DocumentKey, revision: number): InventoryEntry {
  return {
    key,
    durableRevision: revision,
    storagePath: documentImagePath(root, key.kind, key.id),
  };
}

function coalesceChange(queue: InventoryWatchEvent[], event: Extract<InventoryWatchEvent, { type: "change" }>): void {
  for (let i = 0; i < queue.length; i += 1) {
    const pending = queue[i];
    if (pending.type !== "change") continue;
    if (!documentKeysEqual(pending.key, event.key)) continue;
    queue[i] = event;
    return;
  }
  queue.push(event);
}

function formatCursor(cut: number, offset: number): string {
  return `${cut}.${offset}`;
}

function parseCursor(cursor: string): { cut: number; offset: number } | null {
  const sep = cursor.indexOf(".");
  if (sep === -1) return null;
  const cut = Number(cursor.slice(0, sep));
  const offset = Number(cursor.slice(sep + 1));
  if (!Number.isInteger(cut) || !Number.isInteger(offset) || cut < 1 || offset < 0) {
    return null;
  }
  return { cut, offset };
}
