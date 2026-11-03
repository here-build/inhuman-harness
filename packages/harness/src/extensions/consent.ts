import { createHash } from "node:crypto";

/** Order-independent digest of a program's modules. */
export function programDigest(modules: ReadonlyMap<string, string>): string {
  const rows = [...modules].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}
