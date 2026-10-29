/** Object field without `as { key?: unknown }`. `Reflect.get` is lib `any`; this seals it. */
import { unknownRecordSchema } from "../schemas/json-record.js";

export function readField(obj: object, key: string): unknown {
  if (!(key in obj)) return undefined;
  const value: unknown = Reflect.get(obj, key);
  return value;
}

/** One leftover `object` → `Record` hole. */
export function asRecord(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) return null;
  const parsed = unknownRecordSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** `JSON.parse` is lib `any`. Public return is `unknown`. */
export function parseJsonUnknown(text: string): unknown {
  return JSON.parse(text);
}

/** Object JSON or null. Throws stay at the caller when they need fail-open. */
export function parseJsonRecord(text: string): Record<string, unknown> | null {
  try {
    return asRecord(parseJsonUnknown(text));
  } catch {
    return null;
  }
}
