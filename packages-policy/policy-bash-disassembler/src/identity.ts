/**
 * Path-form argv0 is a known command only when `which` returns the same path.
 * Otherwise the token stays a path.
 */

export type Which = (name: string) => string | undefined;

/** Named `cmd` is itself. Path-form is `cmd` only when `which` agrees. */
export function resolveKnown(raw: string, known: ReadonlySet<string>, which: Which | undefined): string | undefined {
  const slash = raw.lastIndexOf("/");
  const base = slash === -1 ? raw : raw.slice(slash + 1) || raw;
  if (base === "" || !known.has(base)) return undefined;
  if (!raw.includes("/")) return base;
  const canonical = which?.(base);
  if (canonical === undefined) return undefined;
  const left = normalizeIdentity(raw);
  const right = normalizeIdentity(canonical);
  return left !== undefined && left === right ? base : undefined;
}

function normalizeIdentity(raw: string): string | undefined {
  if (raw === "" || raw.includes("\0")) return undefined;
  const slash = raw.replaceAll("\\", "/");
  const parts = slash.split("/").filter((seg) => seg !== "" && seg !== ".");
  if (parts.includes("..")) return undefined;
  return slash.startsWith("/") ? `/${parts.join("/")}` : parts.join("/");
}
