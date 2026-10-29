/** Node `types: ["node"]` has `RequestInit`, not DOM `RequestInfo` / `HeadersInit`. */
export type FetchInput = Parameters<typeof fetch>[0];
export type HeaderInit = NonNullable<RequestInit["headers"]>;

export function headersRecord(init?: HeaderInit): Record<string, string> {
  if (init == null) return {};
  if (init instanceof Headers) return Object.fromEntries(init.entries());
  if (Array.isArray(init)) {
    const out: Record<string, string> = {};
    for (const [key, value] of init) out[key] = value;
    return out;
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(init)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}
