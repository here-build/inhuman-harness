import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

/** Width elision is layout, not this file. */
export function homePath(path: string, home: string = homedir()): string {
  if (home === "") return path;
  if (path === home) return "~";
  const prefix = home.endsWith(sep) ? home : home + sep;
  if (path.startsWith(prefix)) return `~${sep}${path.slice(prefix.length)}`;
  return path;
}

/** Innermost git dir/file walking up from `path`. Nested worktrees win. */
export function closestGitRoot(path: string): string | null {
  if (path === "") return null;
  let dir = resolve(path);
  while (true) {
    try {
      if (existsSync(join(dir, ".git"))) return dir;
    } catch {
      return null;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Bright git root + dim rest. No git → whole path is the root. */
export function cwdParts(path: string, home: string = homedir()): { readonly root: string; readonly rest: string } {
  const root = closestGitRoot(path);
  if (root == null) return { root: homePath(path, home), rest: "" };
  const rest = path === root || path.startsWith(root + sep) ? path.slice(root.length) : "";
  return { root: homePath(root, home), rest };
}
