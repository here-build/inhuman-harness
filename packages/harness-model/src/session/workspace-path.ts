/**
 * Host prep for file-access questions. Session cwd is the project root.
 * Lexical only — no realpath, no `~`, no `$`, no `node:path`. In-root
 * becomes relative so enable `"."` matches; extra-root stays absolute so
 * miss is deny (not `..` ask).
 */

function slash(path: string): string {
  return path.replaceAll("\\", "/");
}

function collapse(path: string): string {
  const parts: string[] = [];
  for (const seg of slash(path).split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length > 0) parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return path.startsWith("/") || path.startsWith("\\") ? `/${parts.join("/")}` : parts.join("/");
}

function relativePath(from: string, to: string): string {
  if (from === to) return "";
  const source = from.split("/").filter(Boolean);
  const dest = to.split("/").filter(Boolean);
  let i = 0;
  while (i < source.length && i < dest.length && source[i] === dest[i]) i += 1;
  return [...Array.from({ length: source.length - i }, () => ".."), ...dest.slice(i)].join("/");
}

function resolvedAgainst(cwd: string, raw: string): { root: string; resolved: string; rel: string } {
  const written = raw.trim() === "" ? "." : slash(raw);
  const root = collapse(slash(cwd.startsWith("/") || cwd.startsWith("\\") ? cwd : `/${cwd}`));
  const resolved = written.startsWith("/") ? collapse(written) : collapse(`${root}/${written}`);
  return { root, resolved, rel: relativePath(root, resolved) };
}

export function workspacePath(cwd: string, raw: string): string {
  const written = raw.trim() === "" ? "." : slash(raw);
  if (cwd.trim() === "") return written;
  const { resolved, rel } = resolvedAgainst(cwd, raw);
  if (rel === "") return ".";
  const first = rel.split("/")[0];
  if (rel.startsWith("/") || first === "..") return resolved;
  return rel;
}

/** Relative form even for extra-root (may start with `..`). Chrome labels. */
export function workspaceRelative(cwd: string, raw: string): string {
  if (cwd.trim() === "") return raw.trim() === "" ? "." : slash(raw);
  const { rel } = resolvedAgainst(cwd, raw);
  return rel === "" ? "." : rel;
}
