import { computed, type IComputedValue } from "mobx";
import type { ReadonlyDeep } from "type-fest";

import { unknownRecordSchema } from "./schemas/json-record.js";

export type JsonFace = ReadonlyDeep<Record<string, unknown>> | null;

/**
 * `@syncing` does not prove the cell. Peers store `string | number | null`.
 * Only a string is JSON text.
 */
export function syncingText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** `JSON.parse` is lib `any`. Object JSON or null. */
export function parseJsonRecord(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed)) return null;
    const rec = unknownRecordSchema.safeParse(parsed);
    return rec.success ? rec.data : null;
  } catch {
    return null;
  }
}

export function deepFreeze<T>(value: T): ReadonlyDeep<T> {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value as ReadonlyDeep<T>;
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
  } else {
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return Object.freeze(value) as ReadonlyDeep<T>;
}

/** Object JSON, frozen. Blank text, the string `"null"`, a non-string cell, and a non-object payload are null. */
export function frozenRecord(value: unknown): ReadonlyDeep<Record<string, unknown>> | null {
  const text = syncingText(value)?.trim() ?? "";
  if (text === "" || text === "null") return null;
  const rec = parseJsonRecord(text);
  return rec == null ? null : deepFreeze(rec);
}

export function recordString(rec: Readonly<Record<string, unknown>> | null | undefined, key: string): string {
  const value = rec?.[key];
  return typeof value === "string" ? value.trim() : "";
}

export function stringArg(argsJson: unknown, key: string): string {
  return recordString(frozenRecord(argsJson), key);
}

/**
 * Object face of a `@syncing` JSON string cell.
 * A null face writes a null cell. `""` and `"null"` are not stored.
 * A read in the same action as a write still sees the previous parse.
 */
export function serializingInto(jsonKey: string) {
  return <This extends object>(
    _target: ClassAccessorDecoratorTarget<This, JsonFace>,
    context: ClassAccessorDecoratorContext<This, JsonFace>,
  ): ClassAccessorDecoratorResult<This, JsonFace> => {
    const faces = new WeakMap<object, IComputedValue<JsonFace>>();
    const name = String(context.name);
    const faceOf = (self: This): IComputedValue<JsonFace> => {
      const existing = faces.get(self);
      if (existing !== undefined) return existing;
      // tsc emits addInitializer after a constructor body. A return on the
      // rehydrate symbol skips it; the face is still just the JSON cell.
      const face = computed(
        function (this: This): JsonFace {
          return frozenRecord(Reflect.get(this, jsonKey));
        },
        { name, context: self },
      );
      faces.set(self, face);
      return face;
    };
    context.addInitializer(function (this: This) {
      if (!(jsonKey in this)) {
        throw new Error(`@serializingInto(${JSON.stringify(jsonKey)}) is not a field of ${name}`);
      }
      faceOf(this);
    });
    return {
      get(this: This): JsonFace {
        return faceOf(this).get();
      },
      set(this: This, value: JsonFace): void {
        Reflect.set(this, jsonKey, value == null ? null : JSON.stringify(value));
      },
    };
  };
}
