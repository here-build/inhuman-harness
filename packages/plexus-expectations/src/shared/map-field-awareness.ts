/**
 * One awareness field as a string-keyed map.
 *
 * Each client owns its map. A write patches the local map. A read is the
 * first present entry across bases, local then others, so a peer's key is
 * visible here. `undefined` means the key is absent; `""` and `null` are
 * stored values.
 *
 * Callers read and write through this lens. A process-local map misses
 * every peer entry.
 */
import {
  FieldAwareness,
  type AwarenessShape,
  type PlexusAwareness,
  type ShapeOfAwareness,
} from "@here.build/plexus";

export class MapFieldAwareness<
  A extends PlexusAwareness<AwarenessShape> = PlexusAwareness,
  K extends string & keyof ShapeOfAwareness<A> = string & keyof ShapeOfAwareness<A>,
> extends FieldAwareness<A, K> {
  mapGet(key: string): unknown {
    const own = readAt(this.get(), key);
    if (own !== undefined) return own;
    for (const id of this.clientIds) {
      const value = readAt(this.getOther(id), key);
      if (value !== undefined) return value;
    }
    return undefined;
  }

  mapSet(key: string, value: unknown): void {
    this.#write({ ...this.#record(), [key]: value });
  }

  mapDelete(key: string): void {
    const current = this.#record();
    if (!(key in current)) return;
    delete current[key];
    // An empty object is still a published value. The last delete leaves the lane null.
    if (Object.keys(current).length === 0) this.clear();
    else this.#write(current);
  }

  #record(): Record<string, unknown> {
    const value = this.get();
    if (!isRecord(value)) return {};
    return { ...value };
  }

  /** `set` wants the lane's serializable value. The bag is a plain object. */
  #write(bag: Record<string, unknown>): void {
    this.set(bag as ShapeOfAwareness<A>[K]);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readAt(value: unknown, key: string): unknown {
  if (!isRecord(value) || !(key in value)) return undefined;
  return value[key];
}
