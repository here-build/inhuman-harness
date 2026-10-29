/** Object field without `as { key?: unknown }`. `Reflect.get` is lib `any`; this seals it. */

export function readField(obj: object, key: string): unknown {
  if (!(key in obj)) return undefined;
  const value: unknown = Reflect.get(obj, key);
  return value;
}

/** One leftover `object` → `Record` hole. */
export function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** `JSON.parse` is lib `any`. Public return is `unknown`. */
export function parseJsonUnknown(text: string): unknown {
  return JSON.parse(text);
}
