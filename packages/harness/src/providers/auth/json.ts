/** Object JSON after `JSON.parse`. Arrays fail. */
export function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** `JSON.parse` is lib `any`. Public return is `unknown`. */
export function parseJsonUnknown(text: string): unknown {
  return JSON.parse(text);
}

export function asNonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

export function asNonNegativeInt(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.trunc(n);
}

export function asPositiveInt(value: unknown): number | undefined {
  const n = asNonNegativeInt(value);
  return n !== undefined && n > 0 ? n : undefined;
}

/** Token `expires_in`; missing/invalid becomes 3600. */
export function asExpiresIn(value: unknown): number {
  return asPositiveInt(value) ?? 3600;
}
