/** Object field without `as { key?: unknown }`. */

export function readField(obj: object, key: string): unknown {
  if (!(key in obj)) return undefined;
  return Reflect.get(obj, key);
}

/** Object JSON after `JSON.parse`. Arrays fail. */
export function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function asNonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

export function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item !== "");
}

/** Token `expires_in`. Missing/invalid stays undefined — MCP does not default. */
export function asExpiresIn(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return undefined;
}
