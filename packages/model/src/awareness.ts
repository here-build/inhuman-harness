/**
 * Pure-MobX reactive awareness hub replacing Yjs/Plexus awareness.
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

export class ReactiveAwareness<S extends AwarenessShape = AwarenessShape> {
  readonly clientId: number;
  readonly #clients = observable.map<number, ObservableLaneBag>([], { deep: false });

  constructor(clientId: number = 1) {
    this.clientId = clientId;
    this.#clients.set(clientId, observable.map<string, unknown>([], { deep: false }));
  }

  @computed
  get clientIds(): readonly number[] {
    return [...this.#clients.keys()];
  }

  getLane<K extends string & keyof S>(lane: K, clientId: number = this.clientId): S[K] | undefined {
    return this.#clients.get(clientId)?.get(lane) as S[K] | undefined;
  }

  @action
  setLane<K extends string & keyof S>(lane: K, value: S[K], clientId: number = this.clientId): void {
    let bag = this.#clients.get(clientId);
    if (bag === undefined) {
      bag = observable.map<string, unknown>([], { deep: false });
      this.#clients.set(clientId, bag);
    }
    bag.set(lane, value);
  }

  @action
  clearLane<K extends string & keyof S>(lane: K, clientId: number = this.clientId): void {
    this.#clients.get(clientId)?.delete(lane);
  }

  @action
  removeClient(clientId: number): void {
    this.#clients.delete(clientId);
  }

  @action
  clearAll(): void {
    this.#clients.clear();
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

  set(value: ShapeOfAwareness<A>[K]): void {
    this.hub.setLane(this.field, value);
  }

  clear(): void {
    this.hub.clearLane(this.field);
  }
}

export type { ReactiveAwareness as PlexusAwareness };
