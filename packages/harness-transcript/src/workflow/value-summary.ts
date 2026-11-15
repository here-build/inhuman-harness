/**
 * Collapsed reading of a card value. Strings stay prose. A record with a title,
 * name, or summary uses that sentence. A short flat record reads as words
 * (`warnings 3 · errors 0`). Anything nested or long is a count. Pretty JSON
 * belongs to the expanded view, not this line.
 */

const FLAT_MAX = 4;
const LABEL_KEYS = ["title", "name", "summary"] as const;

const isScalar = (value: unknown): value is string | number | boolean | null =>
  value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";

const scalarText = (value: string | number | boolean | null): string => (value === null ? "null" : String(value));

const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export const isStructured = (value: unknown): value is Record<string, unknown> | readonly unknown[] =>
  typeof value === "object" && value !== null;

export function valueSummary(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === undefined) return "";
  if (value === null) return "null";
  if (Array.isArray(value)) {
    if (value.length > 0 && value.length <= FLAT_MAX && value.every(isScalar))
      return value.map((item) => scalarText(item)).join(" · ");
    return count(value.length, "item", "items");
  }
  if (typeof value !== "object") return String(value);
  const record = value as Record<string, unknown>;
  for (const key of LABEL_KEYS) {
    const field = record[key];
    if (typeof field === "string" && field.trim() !== "") return field;
  }
  const keys = Object.keys(record);
  if (keys.length > 0 && keys.length <= FLAT_MAX && keys.every((key) => isScalar(record[key])))
    return keys
      .map((key) => {
        const field = record[key];
        return `${key} ${isScalar(field) ? scalarText(field) : ""}`;
      })
      .join(" · ");
  return count(keys.length, "field", "fields");
}

/** Pretty JSON for the expanded view of a structured value. */
export function valueJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
