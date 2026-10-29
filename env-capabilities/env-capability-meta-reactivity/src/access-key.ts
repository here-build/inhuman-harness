/**
 * Watch key for a list access. Host `keyOf` (origin+path) wins; else the
 * value's provenance set. Empty both doors — a missing key is not a shared
 * default (that would collide two watches).
 *
 * This is not origin+path extract. Numeric provenance ids are a fallback
 * when the host has not named the access.
 */
import type { SchemeValue } from "@here.build/arrival";
import { AValue } from "@here.build/arrival/reflect-internals";

export type AccessKeyOf = (value: SchemeValue) => string | undefined;

export function provenanceKey(value: unknown): string | undefined {
  if (!(value instanceof AValue) || value.provenance.size === 0) return undefined;
  return [...value.provenance].toSorted((a, b) => a - b).join(",");
}

export function accessKey(value: SchemeValue, keyOf?: AccessKeyOf): string {
  const hooked = keyOf?.(value);
  if (hooked !== undefined && hooked !== "") return hooked;
  const stamped = provenanceKey(value);
  if (stamped !== undefined) return stamped;
  throw new Error("meta-reactivity: list has no path-stable access key");
}
