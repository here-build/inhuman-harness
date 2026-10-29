/** One encoded segment. `%2F` stays inside the segment until decode. */

export type RouteTarget =
  | { readonly kind: "kernel" }
  | { readonly kind: "project"; readonly path: string }
  | { readonly kind: "session"; readonly sessionId: string }
  | { readonly kind: "project-session"; readonly path: string; readonly sessionId: string };

export function projectHref(path: string): string {
  return `/p/${encodeURIComponent(path)}`;
}

export function sessionHref(path: string, sessionId: string): string {
  return `/p/${encodeURIComponent(path)}/s/${encodeURIComponent(sessionId)}`;
}

export function looseSessionHref(sessionId: string): string {
  return `/s/${encodeURIComponent(sessionId)}`;
}

export function readTarget(pathname: string): RouteTarget {
  const parts = pathname.split("/").filter((part) => part !== "");
  if (parts.length === 0) return { kind: "kernel" };
  if (parts[0] === "s" && parts.length === 2) {
    return { kind: "session", sessionId: decodeURIComponent(parts[1] ?? "") };
  }
  if (parts[0] === "p" && parts.length === 2) {
    return { kind: "project", path: decodeURIComponent(parts[1] ?? "") };
  }
  if (parts[0] === "p" && parts.length === 4 && parts[2] === "s") {
    return {
      kind: "project-session",
      path: decodeURIComponent(parts[1] ?? ""),
      sessionId: decodeURIComponent(parts[3] ?? ""),
    };
  }
  return { kind: "kernel" };
}

/** Each project's shortest trailing path no other project shares: `here.build/harness` beside `packages/harness`. */
export function projectNames(paths: readonly string[]): Map<string, string> {
  const segments = new Map(paths.map((path) => [path, path.split(/[\\/]/).filter(Boolean)]));
  const tail = (of: readonly string[], n: number): string => of.slice(-n).join("/");
  const names = new Map<string, string>();
  for (const [path, parts] of segments) {
    let depth = 1;
    while (
      depth < parts.length &&
      [...segments].some(([other, otherParts]) => other !== path && tail(otherParts, depth) === tail(parts, depth))
    ) {
      depth += 1;
    }
    names.set(path, tail(parts, depth) || path);
  }
  return names;
}
