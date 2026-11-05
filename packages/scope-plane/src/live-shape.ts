import {
  shapeSubscribeFrameSchema,
  type ShapeDeltaFrame,
  type ShapeSubscribeFrame,
  type UpdateLaneName,
} from "@inhuman.tools/harness-contract";
import type { Model } from "@inhuman.tools/model";
import { createAtom, observable, runInAction, type IAtom, type ObservableMap } from "mobx";

import type { UpdateLaneHub } from "./lane-server.js";

function toModelRow<TRow extends Record<string, unknown>>(raw: Record<string, unknown>): TRow {
  return raw as TRow;
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
  TRow extends Record<string, unknown>,
  TModel extends Model<TRow>,
  TKey extends keyof TRow & string,
> {
  readonly #lane: UpdateLaneName;
  readonly #params: Record<string, unknown>;
  readonly #keyField: TKey;
  readonly #ModelCtor: new (row: TRow) => TModel;
  readonly #transport: ShapeTransport;
  readonly #graceMs: number;
  readonly #atom: IAtom;
  readonly #items: ObservableMap<string, TModel>;
  readonly #synced = observable.box(false);
  #offset = 0;
  readonly #subscriptionId: string;
  #unsubscribe: (() => void) | null = null;
  #stopTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    lane: UpdateLaneName,
    params: Record<string, unknown>,
    keyField: TKey,
    ModelCtor: new (row: TRow) => TModel,
    transport: ShapeTransport,
    options?: LiveShapeOptions,
  ) {
    this.#lane = lane;
    this.#params = params;
    this.#keyField = keyField;
    this.#ModelCtor = ModelCtor;
    this.#transport = transport;
    this.#graceMs = options?.graceMs ?? 3_000;
    this.#subscriptionId = crypto.randomUUID();
    this.#items = observable.map<string, TModel>([], { deep: false });
    this.#atom = createAtom(
      `LiveShape:${lane}`,
      () => this.#onBecomeObserved(),
      () => this.#onBecomeUnobserved(),
    );
  }

  get lane(): UpdateLaneName {
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

  applyDelta(frame: ShapeDeltaFrame): void {
    runInAction(() => {
      this.#offset = frame.offset;
      if (frame.reset) {
        this.#items.clear();
      }
      for (const id of frame.deletes) {
        this.#items.delete(id);
      }
      for (const raw of frame.upserts) {
        const row = toModelRow<TRow>(raw);
        const rawId = row[this.#keyField];
        const id = String(rawId);
        const existing = this.#items.get(id);
        if (existing != null) {
          existing.applyRow(row);
        } else {
          this.#items.set(id, new this.#ModelCtor(row));
        }
      }
      this.#synced.set(true);
      this.#atom.reportChanged();
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
