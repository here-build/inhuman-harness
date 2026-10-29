/**
 * Session read roots. A single read outside the workspace is soft-deny and is licensed every time:
 * nothing is remembered. The one way to make a folder easier is to ask the question out loud,
 * "Treat <folder> as part of this session?", and a yes adds that folder as a session root. Reads under
 * a root follow the in-workspace rules (the floor sees the root as an enabled read root), so a block
 * rule (`.env`, `.ssh`, …) still blocks there. Writes are never a root.
 */
import { clusterOf, fileQuestion } from "./cluster.js";
import { workspacePath } from "./workspace-path.js";

const HOME_TOP = new Set(["Users", "home", "Volumes", "private"]);

/** The prepared path a read-cluster call asks about. Undefined for any other cluster. */
export function fileReadPreparedPath(
  rootPath: string,
  name: string,
  args: Readonly<Record<string, unknown>> | null | undefined,
): string | undefined {
  if (clusterOf(name) !== "read") return undefined;
  // `fileQuestion` names the one argument that is the path for this tool, so a smuggled `cwd` never
  // widens what is offered.
  return workspacePath(rootPath, fileQuestion(name, args) ?? ".");
}

/** A root is an absolute directory below the volume and home tops: never `/`, `/Users`, `/Users/me`. */
export function isReadRootable(path: string): boolean {
  if (!path.startsWith("/")) return false;
  if (path.includes("\0") || /[*?[{$~`]/.test(path) || path.split("/").includes("..")) return false;
  const segs = path.split("/").filter(Boolean);
  if (segs.length < 2) return false;
  if (segs.length === 2 && HOME_TOP.has(segs[0]!)) return false;
  return true;
}

/** Normalised absolute root, or undefined when the path may not be a root. */
export function readRootOf(rootPath: string, path: string): string | undefined {
  const prepared = workspacePath(rootPath, path);
  const trimmed = prepared.length > 1 ? prepared.replace(/\/+$/, "") : prepared;
  return isReadRootable(trimmed) ? trimmed : undefined;
}

/** Roots (a record keyed by absolute path) as a list. */
export function readRootList(roots: Readonly<Record<string, string>>): string[] {
  return Object.keys(roots).filter(isReadRootable);
}

export function underReadRoot(roots: readonly string[], prepared: string): boolean {
  return roots.some((root) => prepared === root || prepared.startsWith(`${root}/`));
}
