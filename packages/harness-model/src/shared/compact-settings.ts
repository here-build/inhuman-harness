export const DEFAULT_COMPACT_TRIGGERS = { hard: "90%", soft: "80%" } as const;
/** At least one turn must remain outside the prefix being compacted. */
export const DEFAULT_COMPACT_KEEP_TURNS = 1;
export const DEFAULT_LENGTH_CONTINUATIONS = 3;

/** Omitted, invalid or zero is unlimited, except callers may interpret zero as off. */
export function parseLoopLimit(value: unknown, fallback = 0): number {
  if (value === undefined || value === null) return fallback;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/** `90%`, `0.9` and `90` name the same ratio; null disables the trigger. */
export function parseCompactTrigger(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const percent = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s*%$/i.exec(trimmed);
  const raw = percent == null ? Number(trimmed) : Number(percent[1]);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  const ratio = percent != null || raw > 1 ? raw / 100 : raw;
  if (!(ratio > 0) || ratio > 1) return null;
  return ratio;
}
