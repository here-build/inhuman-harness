import {
  shapeSubscribeFrameSchema,
  storedModelRowSchema,
  type ShapeDeltaFrame,
  type ShapeSubscribeFrame,
  type UpdateLaneName,
} from "@inhuman.tools/harness-contract";
import type { DocumentContainer, Model, SerializedModelRow } from "@inhuman.tools/model";
import { createAtom, observable, runInAction, when, type IAtom, type ObservableMap } from "mobx";

import type { UpdateLaneHub } from "./lane-server.js";

function hasApplyRow<T>(val: unknown): val is { applyRow: (row: T) => void } {
  return (
    typeof val === "object" &&
    val !== null &&
    "applyRow" in val &&
    typeof (val as Record<string, unknown>).applyRow === "function"
  );
}

export interface ShapeTransport {
  subscribe(frame: ShapeSubscribeFrame, onDelta: (frame: ShapeDeltaFrame) => void): () => void;
}

export function createLocalShapeTransport(hub: UpdateLaneHub, clientId = "local"): ShapeTransport {
  return {
    subscribe(frame: ShapeSubscribeFrame, onDelta: (frame: ShapeDeltaFrame) => void): () => void {
      return hub.subscribe(frame, onDelta, clientId);
    },
  };
}

/**
 * Transport-agnostic ElectricSQL `/v1/shape` message shape (`@electric-sql/client` compatible).
 */
export type ElectricShapeMessage<TRow extends Record<string, unknown> = Record<string, unknown>> = {
  readonly headers: {
    readonly operation?: "insert" | "update" | "delete";
    readonly control?: "up-to-date" | "must-refetch" | "snapshot-end";
  };
  readonly key?: string;
  readonly value?: Partial<TRow>;
  readonly offset?: string;
};

export interface LiveShapeOptions {
  readonly graceMs?: number;
  readonly onDelta?: (delta: ShapeDeltaFrame) => void;
}

export class LiveShape<TKey = string, TRow extends Record<string, unknown> = Record<string, unknown>, TModel = TRow> {
  readonly #lane?: UpdateLaneName;
  readonly #params?: Record<string, unknown>;
  readonly #keyField?: keyof TRow & string;
  readonly #keyFn?: (row: TRow) => unknown;
  readonly #ModelCtor?: new (row: TRow) => TModel;
  readonly #transport?: ShapeTransport;
  readonly #graceMs: number;
  readonly #onDelta?: (delta: ShapeDeltaFrame) => void;
  readonly #atom: IAtom;
  readonly #items: ObservableMap<string, TModel>;
  readonly #rawRows = new Map<string, TRow>();
  #refetchBuffer: Map<string, TRow> | null = null;
  readonly #synced = observable.box(false);
  readonly #error = observable.box<Error | null>(null, { deep: false });
  #offset = 0;
  readonly #subscriptionId: string;
  #unsubscribe: (() => void) | null = null;
  #stopTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(keyFn: (row: TRow) => unknown, options?: LiveShapeOptions);
  constructor(
    lane: UpdateLaneName,
    params: Record<string, unknown>,
    keyField: keyof TRow & string,
    ModelCtor: (new (row: TRow) => TModel) | undefined,
    transport: ShapeTransport,
    options?: LiveShapeOptions,
  );
  constructor(
    laneOrKeyFn: UpdateLaneName | ((row: TRow) => unknown),
    paramsOrOptions?: Record<string, unknown> | LiveShapeOptions,
    keyField?: keyof TRow & string,
    ModelCtor?: new (row: TRow) => TModel,
    transport?: ShapeTransport,
    options?: LiveShapeOptions,
  ) {
    this.#items = observable.map<string, TModel>([], { deep: false });
    this.#subscriptionId = crypto.randomUUID();
    if (typeof laneOrKeyFn === "function") {
      const clientOpts = paramsOrOptions as LiveShapeOptions | undefined;
      this.#keyFn = laneOrKeyFn;
      this.#graceMs = clientOpts?.graceMs ?? 3_000;
      this.#onDelta = clientOpts?.onDelta;
      this.#atom = createAtom("LiveShape:client");
    } else {
      this.#lane = laneOrKeyFn;
      this.#params = (paramsOrOptions as Record<string, unknown> | undefined) ?? {};
      this.#keyField = keyField;
      this.#ModelCtor = ModelCtor;
      this.#transport = transport;
      this.#graceMs = options?.graceMs ?? 3_000;
      this.#onDelta = options?.onDelta;
      this.#atom = createAtom(
        `LiveShape:${laneOrKeyFn}`,
        () => this.#onBecomeObserved(),
        () => this.#onBecomeUnobserved(),
      );
      if (this.#onDelta && this.#transport) {
        this.#connect();
      }
    }
  }

  get lane(): UpdateLaneName | undefined {
    return this.#lane;
  }

  get subscriptionId(): string {
    return this.#subscriptionId;
  }

  get rows(): ReadonlyMap<string, TModel> {
    this.#atom.reportObserved();
    return this.#items;
  }

  get list(): readonly TModel[] {
    this.#atom.reportObserved();
    return [...this.#items.values()];
  }

  get synced(): boolean {
    this.#atom.reportObserved();
    return this.#synced.get();
  }

  get upToDate(): boolean {
    return this.synced;
  }

  get error(): Error | null {
    this.#atom.reportObserved();
    return this.#error.get();
  }

  get offset(): number {
    this.#atom.reportObserved();
    return this.#offset;
  }

  get isSubscribed(): boolean {
    return this.#unsubscribe != null;
  }

  get(key: string | TKey): TModel | undefined {
    this.#atom.reportObserved();
    return this.#items.get(String(key));
  }

  has(key: string | TKey): boolean {
    this.#atom.reportObserved();
    return this.#items.has(String(key));
  }

  reportError(cause: unknown): void {
    const err = cause instanceof Error ? cause : new Error(String(cause));
    runInAction(() => {
      this.#error.set(err);
      this.#atom.reportChanged();
    });
  }

  async ready(signal?: AbortSignal): Promise<void> {
    if (this.#unsubscribe == null && this.#transport && this.#lane && !this.#synced.get()) {
      this.#connect();
    }
    await when(() => this.#synced.get() || this.#error.get() !== null, { signal });
    const err = this.#error.get();
    if (err !== null) {
      throw err;
    }
  }

  #resolveKey(row: TRow, fallbackKey?: string): string {
    if (this.#keyFn) return String(this.#keyFn(row));
    if (this.#keyField && row[this.#keyField] !== undefined) return String(row[this.#keyField]);
    const rec = row as Record<string, unknown>;
    const candidate = rec.id ?? rec.sessionId ?? rec.session_id ?? rec.jobId ?? rec.job_id ?? fallbackKey ?? "";
    return String(candidate);
  }

  #upsertModelRow(id: string, row: TRow): void {
    this.#rawRows.set(id, row);
    const existing = this.#items.get(id);
    if (hasApplyRow<TRow>(existing)) {
      existing.applyRow(row);
    } else if (this.#ModelCtor) {
      this.#items.set(id, new this.#ModelCtor(row));
    } else {
      this.#items.set(id, row as unknown as TModel);
    }
  }

  applyFrame(frame: unknown): void {
    runInAction(() => {
      if (!frame || typeof frame !== "object") return;
      const obj = frame as Record<string, unknown>;
      if (typeof obj.offset === "number") {
        this.#offset = obj.offset;
      }
      const isReset = obj.reset === true;
      if (isReset) {
        this.#items.clear();
        this.#rawRows.clear();
      }
      const deletedIds: string[] = [];
      if (Array.isArray(obj.deletes)) {
        for (const id of obj.deletes) {
          const strId = String(id);
          deletedIds.push(strId);
          this.#items.delete(strId);
          this.#rawRows.delete(strId);
        }
      }
      const rawUpserts = Array.isArray(obj.upserts)
        ? obj.upserts
        : Array.isArray(obj.rows)
          ? obj.rows
          : Array.isArray(obj.items)
            ? obj.items
            : Array.isArray(obj.data)
              ? obj.data
              : Array.isArray(frame)
                ? frame
                : null;
      const upsertedRecords: Record<string, unknown>[] = [];
      if (rawUpserts) {
        for (const raw of rawUpserts) {
          if (raw && typeof raw === "object") {
            const row = raw as TRow;
            const id = this.#resolveKey(row);
            this.#upsertModelRow(id, row);
            upsertedRecords.push(row);
          }
        }
      }
      this.#error.set(null);
      this.#synced.set(true);
      this.#atom.reportChanged();

      if (this.#onDelta) {
        this.#onDelta({
          kind: "shape/delta",
          subscriptionId: this.#subscriptionId,
          offset: this.#offset,
          upserts: upsertedRecords,
          deletes: deletedIds,
          reset: isReset,
        });
      }
    });
  }

  applyDelta(frame: ShapeDeltaFrame): void {
    this.applyFrame(frame);
  }

  /**
   * Fold a batch of ElectricSQL `/v1/shape` messages into this `LiveShape`.
   * Double-buffers during `must-refetch` until `up-to-date` arrives so UI observers
   * never flash empty during Electric log compaction or shape handle rotation.
   */
  applyElectricMessages(messages: readonly ElectricShapeMessage<TRow>[]): void {
    if (messages.length === 0) return;

    runInAction(() => {
      const batchUpserts = new Map<string, TRow>();
      const batchDeletes = new Set<string>();
      let completedRefetch = false;
      let sawUpToDate = false;

      for (const msg of messages) {
        const control = msg.headers.control;
        if (control === "must-refetch") {
          this.#refetchBuffer = new Map<string, TRow>();
          batchUpserts.clear();
          batchDeletes.clear();
          continue;
        }
        if (control === "up-to-date") {
          sawUpToDate = true;
          if (this.#refetchBuffer !== null) {
            const nextRows = this.#refetchBuffer;
            this.#refetchBuffer = null;
            completedRefetch = true;

            for (const existingKey of [...this.#items.keys()]) {
              if (!nextRows.has(existingKey)) {
                this.#items.delete(existingKey);
                this.#rawRows.delete(existingKey);
                batchDeletes.add(existingKey);
              }
            }
            for (const [id, row] of nextRows.entries()) {
              this.#upsertModelRow(id, row);
              batchUpserts.set(id, row);
            }
          }
          continue;
        }

        const op = msg.headers.operation;
        if (!op) continue;

        if (this.#refetchBuffer !== null) {
          if (op === "delete") {
            if (msg.key !== undefined) this.#refetchBuffer.delete(msg.key);
          } else if (msg.value) {
            const prev = msg.key !== undefined ? this.#refetchBuffer.get(msg.key) : undefined;
            const merged = (prev ? { ...prev, ...msg.value } : { ...msg.value }) as TRow;
            const id = this.#resolveKey(merged, msg.key);
            this.#refetchBuffer.set(id, merged);
          }
          continue;
        }

        if (op === "delete") {
          const fallbackId = msg.value ? this.#resolveKey(msg.value as TRow, msg.key) : msg.key;
          if (fallbackId !== undefined) {
            const strId = String(fallbackId);
            this.#items.delete(strId);
            this.#rawRows.delete(strId);
            batchUpserts.delete(strId);
            batchDeletes.add(strId);
          }
        } else if (msg.value) {
          const prevKey = msg.value ? this.#resolveKey(msg.value as TRow, msg.key) : msg.key;
          const prev = prevKey !== undefined ? this.#rawRows.get(String(prevKey)) : undefined;
          const merged = (prev ? { ...prev, ...msg.value } : { ...msg.value }) as TRow;
          const id = this.#resolveKey(merged, msg.key);
          this.#upsertModelRow(id, merged);
          batchDeletes.delete(id);
          batchUpserts.set(id, merged);
        }
      }

      if (sawUpToDate) {
        this.#offset += 1;
        this.#error.set(null);
        this.#synced.set(true);
      }

      if (sawUpToDate || batchUpserts.size > 0 || batchDeletes.size > 0) {
        this.#atom.reportChanged();
      }

      if (this.#onDelta && (completedRefetch || batchUpserts.size > 0 || batchDeletes.size > 0)) {
        this.#onDelta({
          kind: "shape/delta",
          subscriptionId: this.#subscriptionId,
          offset: this.#offset,
          upserts: [...batchUpserts.values()],
          deletes: [...batchDeletes],
          reset: completedRefetch,
        });
      }
    });
  }

  dispose(): void {
    if (this.#stopTimer != null) {
      clearTimeout(this.#stopTimer);
      this.#stopTimer = null;
    }
    this.#disconnect();
    runInAction(() => {
      this.#items.clear();
      this.#rawRows.clear();
      this.#refetchBuffer = null;
      this.#synced.set(false);
      this.#atom.reportChanged();
    });
  }

  connect(): () => void {
    if (this.#stopTimer != null) {
      clearTimeout(this.#stopTimer);
      this.#stopTimer = null;
    }
    if (this.#unsubscribe == null) {
      this.#connect();
    }
    return () => this.#disconnect();
  }

  #onBecomeObserved(): void {
    if (this.#stopTimer != null) {
      clearTimeout(this.#stopTimer);
      this.#stopTimer = null;
    }
    if (this.#unsubscribe == null) {
      this.#connect();
    }
  }

  #onBecomeUnobserved(): void {
    if (this.#onDelta) {
      // Keep active while driving an external DocumentContainer sink until dispose()
      return;
    }
    if (this.#stopTimer != null) {
      clearTimeout(this.#stopTimer);
    }
    this.#stopTimer = setTimeout(() => {
      this.#disconnect();
      this.#stopTimer = null;
    }, this.#graceMs);
  }

  #connect(): void {
    if (!this.#transport || !this.#lane) return;
    const frame = shapeSubscribeFrameSchema.parse({
      kind: "shape/subscribe",
      subscriptionId: this.#subscriptionId,
      lane: this.#lane,
      params: this.#params,
      offset: this.#offset > 0 ? this.#offset : undefined,
    });

    this.#unsubscribe = this.#transport.subscribe(frame, (delta) => {
      this.applyDelta(delta);
    });
  }

  #disconnect(): void {
    if (this.#unsubscribe != null) {
      this.#unsubscribe();
      this.#unsubscribe = null;
    }
  }
}

/**
 * Hydrate or live-patch a `DocumentContainer` (`KernelDocument`, `ProjectDocument`, `SessionDocument`)
 * from `scope_nodes` or `session_nodes` rows emitted by either local SQLite `UpdateLaneHub` (`camelCase`)
 * or ElectricSQL `/v1/shape` (`snake_case`).
 */
export function applyNodeShapeDelta<TRoot extends Model>(
  container: DocumentContainer<TRoot, any>,
  delta: Pick<ShapeDeltaFrame, "upserts" | "deletes" | "reset">,
): void {
  let rootId: string | undefined;
  let maxRevision: number | undefined;
  const modelUpserts: SerializedModelRow[] = [];

  for (const raw of delta.upserts) {
    const rawRowJson = raw.rowJson ?? raw.row_json;
    if (typeof rawRowJson !== "string") continue;
    const parsedRow = storedModelRowSchema.parse(JSON.parse(rawRowJson));
    modelUpserts.push(parsedRow);

    const isRoot = raw.isRoot === true || raw.isRoot === 1 || raw.is_root === true || raw.is_root === 1;
    if (isRoot) {
      rootId = parsedRow.uuid;
    }
    const rev = typeof raw.revision === "number" ? raw.revision : Number(raw.revision);
    if (Number.isFinite(rev)) {
      maxRevision = maxRevision === undefined ? rev : Math.max(maxRevision, rev);
    }
  }

  container.applyNodeRows({
    rootId,
    revision: maxRevision,
    upserts: modelUpserts,
    deletes: delta.deletes,
    reset: delta.reset,
  });
}
