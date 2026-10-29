/**
 * `!` is a deny carve-out. Empty matchers select every call.
 * The pattern itself is `path.matchesGlob`.
 */
import { matchesGlob } from "node:path";

export function selectionMatches(globs: readonly string[], paths: readonly string[]): boolean {
  if (globs.length === 0) return true;
  if (paths.length === 0) return false;
  return paths.every((path) => pathSelected(globs, path));
}

function pathSelected(globs: readonly string[], path: string): boolean {
  let selected = false;
  for (const glob of globs) {
    if (glob.startsWith("!")) {
      if (matchesGlob(path, glob.slice(1))) return false;
      continue;
    }
    if (matchesGlob(path, glob)) selected = true;
  }
  return selected;
}
