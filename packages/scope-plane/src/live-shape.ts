import {
  shapeSubscribeFrameSchema,
  type ShapeDeltaFrame,
  type ShapeSubscribeFrame,
  type UpdateLaneName,
} from "@inhuman.tools/harness-contract";
import { createAtom, observable, runInAction, type IAtom, type ObservableMap } from "mobx";

import type { UpdateLaneHub } from "./lane-server.js";

function hasApplyRow<T>(val: unknown): val is { applyRow: (row: T) => void } {
  return typeof val === "object" && val !== null && "applyRow" in val && typeof (val as Record<string, unknown>).applyRow === "function";
}

export interface ShapeTransport {
  subscribe(frame: ShapeSubscribeFrame, onDelta: (frame: ShapeDeltaFrame) => void): () => void;
}

export function createLocalShapeTransport(hub: UpdateLaneHub): ShapeTransport {
  return {
    subscribe(frame: ShapeSubscribeFrame, onDelta: (frame: ShapeDeltaFrame) => void): () => void {
      return hub.subscribe(frame, onDelta);
    },
  };
}

export interface LiveShapeOptions {
  readonly graceMs?: number;
}

export class LiveShape<
  TKey = string,
  TRow extends Record<string, unknown> = Record<string, unknown>,
  TModel = TRow,
> {
  readonly #lane?: UpdateLaneName;
  readonly #params?: Record<string, unknown>;
  readonly #keyField?: keyof TRow & string;
  readonly #keyFn?: (row: TRow) => unknown;
  readonly #ModelCtor?: new (row: TRow) => TModel;
  readonly #transport?: ShapeTransport;
  readonly #graceMs: number;
  readonly #atom: IAtom;
  readonly #items: ObservableMap<string, TModel>;
  readonly #synced = observable.box(false);
  #offset = 0;
  readonly #subscriptionId: string;
  #unsubscribe: (() => void) | null = null;
  #stopTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(keyFn: (row: TRow) => unknown);
  constructor(
    lane: UpdateLaneName,
    params: Record<string, unknown>,
    keyField: keyof TRow & string,
    ModelCtor: new (row: TRow) => TModel,
    transport: ShapeTransport,
    options?: LiveShapeOptions,
  );
  constructor(
    laneOrKeyFn: UpdateLaneName | ((row: TRow) => unknown),
    params?: Record<string, unknown>,
    keyField?: keyof TRow & string,
    ModelCtor?: new (row: TRow) => TModel,
    transport?: ShapeTransport,
    options?: LiveShapeOptions,
  ) {
    this.#items = observable.map<string, TModel>([], { deep: false });
    this.#subscriptionId = crypto.randomUUID();
    if (typeof laneOrKeyFn === "function") {
      this.#keyFn = laneOrKeyFn;
      this.#graceMs = 3_000;
      this.#atom = createAtom("LiveShape:client");
    } else {
      this.#lane = laneOrKeyFn;
      this.#params = params ?? {};
      this.#keyField = keyField;
      this.#ModelCtor = ModelCtor;
      this.#transport = transport;
      this.#graceMs = options?.graceMs ?? 3_000;
      this.#atom = createAtom(
        `LiveShape:${laneOrKeyFn}`,
        () => this.#onBecomeObserved(),
        () => this.#onBecomeUnobserved(),
      );
    }
  }

  get lane(): UpdateLaneName | undefined {
    return this.#lane;
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

  applyFrame(frame: unknown): void {
    runInAction(() => {
      if (!frame || typeof frame !== "object") return;
      const obj = frame as Record<string, unknown>;
      if (typeof obj.offset === "number") {
        this.#offset = obj.offset;
      }
      if (obj.reset === true) {
        this.#items.clear();
      }
      if (Array.isArray(obj.deletes)) {
        for (const id of obj.deletes) {
          this.#items.delete(String(id));
        }
      }
      const upserts = Array.isArray(obj.upserts)
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
      if (upserts) {
        for (const raw of upserts) {
          if (raw && typeof raw === "object") {
            const row = raw as TRow;
            const id = this.#keyFn
              ? String(this.#keyFn(row))
              : this.#keyField
                ? String(row[this.#keyField])
                : String(
                    (row as Record<string, unknown>).id ??
                      (row as Record<string, unknown>).sessionId ??
                      (row as Record<string, unknown>).jobId ??
                      "",
                  );
            const existing = this.#items.get(id);
            if (hasApplyRow<TRow>(existing)) {
              existing.applyRow(row);
            } else if (this.#ModelCtor) {
              this.#items.set(id, new this.#ModelCtor(row));
            } else {
              this.#items.set(id, row as unknown as TModel);
            }
          }
        }
      }
      this.#synced.set(true);
      this.#atom.reportChanged();
    });
  }

  applyDelta(frame: ShapeDeltaFrame): void {
    this.applyFrame(frame);
  }

  dispose(): void {
    if (this.#stopTimer != null) {
      clearTimeout(this.#stopTimer);
      this.#stopTimer = null;
    }
    this.#disconnect();
    runInAction(() => {
      this.#items.clear();
      this.#synced.set(false);
      this.#atom.reportChanged();
    });
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
