import { z } from "zod";

/** Object JSON after `JSON.parse`. Arrays fail. */
export const unknownRecordSchema = z.record(z.string(), z.unknown());

/**
 * Tool `argsJson` at a Zod boundary. Empty string is `{}`.
 * Invalid JSON becomes `undefined` so the next object schema fails —
 * callers choose `null` vs defaults; this does not.
 */
export function argsJsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    const parsed: unknown = JSON.parse(value === "" ? "{}" : value);
    return parsed;
  } catch {
    return undefined;
  }
}
