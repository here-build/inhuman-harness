/**
 * JSON file RMW. A throw from `transformer` leaves the file untouched.
 * The transformer always returns the value that is written.
 * The daemon and `harness install` share this one writer.
 */
import { readFileSync, writeFileSync } from "node:fs";

export function adjustJson<T>(path: string, transformer: (value: unknown) => T): T {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")) as unknown;
  } catch {
    raw = undefined;
  }
  const next = transformer(raw);
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}
