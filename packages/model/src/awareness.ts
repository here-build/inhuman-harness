/**
 * Pure-MobX reactive awareness hub.
 * Tracks per-client ephemeral state lanes (`clientId -> lane -> value`) in an
 * observable map so `@computed` and `reaction` readers track lane reads automatically.
 */
import { action, computed, observable } from "mobx";

export type AwarenessSerializable =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly AwarenessSerializable[]
  | { readonly [key: string]: AwarenessSerializable };

export type AwarenessShape = Record<string, unknown>;

export type ShapeOfAwareness<A> = A extends ReactiveAwareness<infer S> ? S : AwarenessShape;

export type AwarenessUpdateChange = {
  added: number[];
  updated: number[];
  removed: number[];
};

export type AwarenessUpdateListener = (changed: AwarenessUpdateChange, origin?: unknown) => void;

export type PresenceEntry = readonly [clientId: number, state: Record<string, unknown> | null, clock?: number];

let nextAwarenessClientId = 1;

function resolveClientId(
  input?: number | { readonly clientId?: number; readonly clientID?: number } | unknown,
): number {
  if (typeof input === "number" && Number.isFinite(input)) {
    if (input >= nextAwarenessClientId) nextAwarenessClientId = input + 1;
    return input;
  }
  if (input != null && typeof input === "object") {
    const candidate =
      (input as { clientId?: unknown; clientID?: unknown }).clientId ?? (input as { clientID?: unknown }).clientID;
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      if (candidate >= nextAwarenessClientId) nextAwarenessClientId = candidate + 1;
      return candidate;
    }
  }
  return nextAwarenessClientId++;
}

export class ReactiveAwareness<S extends AwarenessShape = AwarenessShape> {
  doc?: unknown;
  readonly clientId: number;
  readonly meta = new Map<number, { clock: number; lastUpdated: number }>();
  readonly #clients = observable.map<number, ObservableLaneBag>([], { deep: false });
  readonly #listeners = new Set<AwarenessUpdateListener>();
  readonly #destroyListeners = new Set<() => void>();

  constructor(clientIdOrDoc?: number | unknown) {
    if (clientIdOrDoc != null && typeof clientIdOrDoc === "object") {
      this.doc = clientIdOrDoc;
    }
    this.clientId = resolveClientId(clientIdOrDoc);
    this.#clients.set(this.clientId, observable.map<string, unknown>([], { deep: false }));
  }

  get clientID(): number {
    return this.clientId;
  }

  @computed
  get clientIds(): readonly number[] {
    return [...this.#clients.keys()];
  }

  ownsKey(clientId: number): boolean {
    return clientId === this.clientId;
  }

  getStates(): Map<number, Record<string, unknown>> {
    const out = new Map<number, Record<string, unknown>>();
    for (const [id, bag] of this.#clients.entries()) {
      if (bag.size === 0 && !this.meta.has(id)) continue;
      out.set(id, Object.fromEntries(bag.entries()));
    }
    return out;
  }

  getLocalState(): Record<string, unknown> | null {
    const bag = this.#clients.get(this.clientId);
    if (bag === undefined || (bag.size === 0 && !this.meta.has(this.clientId))) return null;
    return Object.fromEntries(bag.entries());
  }

  on(event: "update" | "change", listener: AwarenessUpdateListener): void;
  on(event: "destroy", listener: () => void): void;
  on(event: "update" | "change" | "destroy", listener: AwarenessUpdateListener | (() => void)): void;
  on(event: "update" | "change" | "destroy", listener: AwarenessUpdateListener | (() => void)): void {
    if (event === "destroy") {
      this.#destroyListeners.add(listener as () => void);
    } else {
      this.#listeners.add(listener as AwarenessUpdateListener);
    }
  }

  off(event: "update" | "change", listener: AwarenessUpdateListener): void;
  off(event: "destroy", listener: () => void): void;
  off(event: "update" | "change" | "destroy", listener: AwarenessUpdateListener | (() => void)): void;
  off(event: "update" | "change" | "destroy", listener: AwarenessUpdateListener | (() => void)): void {
    if (event === "destroy") {
      this.#destroyListeners.delete(listener as () => void);
    } else {
      this.#listeners.delete(listener as AwarenessUpdateListener);
    }
  }

  #emitUpdate(changed: AwarenessUpdateChange, origin?: unknown): void {
    if (changed.added.length === 0 && changed.updated.length === 0 && changed.removed.length === 0) return;
    for (const listener of this.#listeners) {
      listener(changed, origin);
    }
  }

  #bumpMeta(clientId: number, clock?: number): void {
    const prev = this.meta.get(clientId)?.clock ?? 0;
    this.meta.set(clientId, {
      clock: clock !== undefined ? Math.max(prev + 1, clock) : prev + 1,
      lastUpdated: Date.now(),
    });
  }

  getLane<K extends string & keyof S>(lane: K, clientId: number = this.clientId): S[K] | undefined {
    return this.#clients.get(clientId)?.get(lane) as S[K] | undefined;
  }

  getField<K extends string & keyof S>(lane: K, clientId: number = this.clientId): S[K] | undefined {
    return this.getLane(lane, clientId);
  }

  @action
  setLane<K extends string & keyof S>(lane: K, value: S[K], clientId: number = this.clientId, origin?: unknown): void {
    const hadMeta = this.meta.has(clientId);
    let bag = this.#clients.get(clientId);
    if (bag === undefined) {
      bag = observable.map<string, unknown>([], { deep: false });
      this.#clients.set(clientId, bag);
    }
    bag.set(lane, value);
    this.#bumpMeta(clientId);
    this.#emitUpdate(
      {
        added: hadMeta ? [] : [clientId],
        updated: hadMeta ? [clientId] : [],
        removed: [],
      },
      origin,
    );
  }

  setField<K extends string & keyof S>(lane: K, value: S[K], clientId: number = this.clientId): void {
    this.setLane(lane, value, clientId);
  }

  setLocalStateField<K extends string & keyof S>(lane: K, value: S[K]): void {
    this.setLane(lane, value, this.clientId);
  }

  @action
  setLocalState(state: Record<string, unknown> | null, origin?: unknown): void {
    if (state === null) {
      this.removeClient(this.clientId, origin);
      return;
    }
    const hadMeta = this.meta.has(this.clientId);
    let bag = this.#clients.get(this.clientId);
    if (bag === undefined) {
      bag = observable.map<string, unknown>([], { deep: false });
      this.#clients.set(this.clientId, bag);
    } else {
      bag.clear();
    }
    for (const [k, v] of Object.entries(state)) {
      bag.set(k, v);
    }
    this.#bumpMeta(this.clientId);
    this.#emitUpdate(
      {
        added: hadMeta ? [] : [this.clientId],
        updated: hadMeta ? [this.clientId] : [],
        removed: [],
      },
      origin,
    );
  }

  @action
  clearLane<K extends string & keyof S>(lane: K, clientId: number = this.clientId, origin?: unknown): void {
    const bag = this.#clients.get(clientId);
    if (!bag?.has(lane)) return;
    bag.delete(lane);
    this.#bumpMeta(clientId);
    this.#emitUpdate({ added: [], updated: [clientId], removed: [] }, origin);
  }

  clearField<K extends string & keyof S>(lane: K, clientId: number = this.clientId): void {
    this.clearLane(lane, clientId);
  }

  @action
  removeClient(clientId: number, origin?: unknown): void {
    const existed = this.#clients.has(clientId) || this.meta.has(clientId);
    this.#clients.delete(clientId);
    this.meta.delete(clientId);
    if (existed) {
      this.#emitUpdate({ added: [], updated: [], removed: [clientId] }, origin);
    }
  }

  toPresenceEntries(clients: readonly number[] = [...this.meta.keys()]): PresenceEntry[] {
    const states = this.getStates();
    const entries: PresenceEntry[] = [];
    for (const id of clients) {
      const state = states.get(id) ?? null;
      const clock = this.meta.get(id)?.clock ?? 1;
      entries.push([id, state, clock]);
    }
    return entries;
  }

  applyPresenceEntries(entries: readonly PresenceEntry[], origin?: unknown): void {
    this.applyClientEntries(entries, origin);
  }

  @action
  applyClientEntries(entries: readonly PresenceEntry[], origin?: unknown): void {
    const added: number[] = [];
    const updated: number[] = [];
    const removed: number[] = [];
    for (const [clientId, state, clock] of entries) {
      if (state === null) {
        const existed = this.#clients.has(clientId) || this.meta.has(clientId);
        this.#clients.delete(clientId);
        if (clock !== undefined) {
          this.meta.set(clientId, { clock, lastUpdated: Date.now() });
        } else {
          this.meta.delete(clientId);
        }
        if (existed) removed.push(clientId);
        continue;
      }
      const hadMeta = this.meta.has(clientId) && (this.#clients.get(clientId)?.size ?? 0) > 0;
      let bag = this.#clients.get(clientId);
      if (bag === undefined) {
        bag = observable.map<string, unknown>([], { deep: false });
        this.#clients.set(clientId, bag);
      }
      for (const key of [...bag.keys()]) {
        if (!(key in state) || state[key] === undefined) {
          bag.delete(key);
        }
      }
      for (const [k, v] of Object.entries(state)) {
        if (v !== undefined) bag.set(k, v);
      }
      this.#bumpMeta(clientId, clock);
      if (hadMeta) updated.push(clientId);
      else added.push(clientId);
    }
    this.#emitUpdate({ added, updated, removed }, origin);
  }

  @action
  clearAll(): void {
    this.#clients.clear();
    this.meta.clear();
  }

  destroy(): void {
    this.clearAll();
    for (const listener of this.#destroyListeners) {
      try {
        listener();
      } catch {
        // preserve destroy semantics
      }
    }
    this.#destroyListeners.clear();
    this.#listeners.clear();
  }

  getSchema(): string[] {
    const lanes = new Set<string>();
    for (const bag of this.#clients.values()) {
      for (const lane of bag.keys()) {
        lanes.add(lane);
      }
    }
    return [...lanes];
  }
}

type ObservableLaneBag = ReturnType<typeof observable.map<string, unknown>>;

export class FieldAwareness<
  A extends ReactiveAwareness<any> = ReactiveAwareness,
  K extends string & keyof ShapeOfAwareness<A> = string & keyof ShapeOfAwareness<A>,
> {
  constructor(
    readonly hub: A,
    readonly field: K,
  ) {}

  get clientIds(): readonly number[] {
    return this.hub.clientIds;
  }

  get(): ShapeOfAwareness<A>[K] | undefined {
    return this.hub.getLane(this.field);
  }

  getOther(clientId: number): ShapeOfAwareness<A>[K] | undefined {
    return this.hub.getLane(this.field, clientId);
  }

  getOthers(): Map<number, ShapeOfAwareness<A>[K]> {
    const out = new Map<number, ShapeOfAwareness<A>[K]>();
    for (const clientId of this.hub.clientIds) {
      if (clientId === this.hub.clientId) continue;
      const val = this.hub.getLane(this.field, clientId);
      if (val !== undefined) {
        out.set(clientId, val);
      }
    }
    return out;
  }

  set(value: ShapeOfAwareness<A>[K]): void {
    this.hub.setLane(this.field, value);
  }

  clear(): void {
    this.hub.clearLane(this.field);
  }
}

export const PlexusAwareness = ReactiveAwareness;
export type PlexusAwareness<S extends AwarenessShape = AwarenessShape> = ReactiveAwareness<S>;
