/**
 * Plexus `@syncing.record` bags are `Record<string, string>`. Values round-trip
 * through JSON.stringify; `undefined` is omitted.
 */

/** Process self-report on ConnectionSpec / DriverSpec. JSON through `liveMap`. */
export type LiveFacts = {
  readonly [key: string]: unknown | undefined;
  readonly models?: readonly string[];
  readonly tools?: unknown;
};
export function readJsonRecord(map: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(map)) {
    try {
      out[key] = JSON.parse(raw);
    } catch {
      out[key] = raw;
    }
  }
  return deepFreeze(out);
}

export function writeJsonRecord(
  map: Record<string, string>,
  next: Readonly<Record<string, unknown>> | undefined,
): void {
  const encoded: Record<string, string> = {};
  for (const [key, value] of Object.entries(next ?? {})) {
    if (value === undefined) continue;
    encoded[key] = JSON.stringify(value);
  }
  for (const key of Object.keys(map)) {
    if (!(key in encoded)) delete map[key];
  }
  for (const [key, value] of Object.entries(encoded)) {
    if (map[key] !== value) map[key] = value;
  }
}

export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
  } else {
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
  }
  return Object.freeze(value);
}
