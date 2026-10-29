/**
 * Host path preparation for the file floor, for hosts that hand the model's path
 * string straight to the adapter. Mirrors the harness's `workspacePath`: resolve
 * against the working directory, collapse `.` / `..`, make in-root paths relative,
 * leave extra-root paths absolute (so a miss is `deny`, never `..` ask).
 * Lexical only: no realpath, so a symlink inside the tree is not followed.
 * The floor matches case-sensitively, so `checkToolPath` also asks about the
 * lower-cased path and keeps the stricter answer (`.GIT/hooks` is `.git/hooks`
 * on APFS and NTFS).
 */
import { homedir } from "node:os";
import path from "node:path";

import { defaultPolicy } from "./bind.js";
import { lattice } from "./lift.js";
import type { Disposition } from "./types.js";

function slash(text: string): string {
  return text.replaceAll("\\", "/");
}

export function normalizeToolPath(raw: string, cwd: string = process.cwd(), home: string = homedir()): string {
  let written = slash(raw.trim() === "" ? "." : raw.trim());
  if (written === "~" || written.startsWith("~/")) written = `${slash(home)}${written.slice(1)}`;
  const root = path.posix.normalize(slash(cwd.startsWith("/") || /^[a-z]:/i.test(cwd) ? cwd : `/${cwd}`));
  const resolved = path.posix.normalize(written.startsWith("/") ? written : path.posix.join(root, written));
  const trimmed = resolved.length > 1 && resolved.endsWith("/") ? resolved.slice(0, -1) : resolved;
  const rel = path.posix.relative(root, trimmed);
  if (rel === "") return ".";
  if (rel === ".." || rel.startsWith("../") || rel.startsWith("/")) return trimmed;
  return rel;
}

/** Strictest dist-floor answer for a model-supplied path, after host normalisation. */
export function checkToolPath(
  operation: "read" | "write",
  raw: string,
  options?: { readonly cwd?: string; readonly home?: string },
): Disposition {
  const prepared = normalizeToolPath(raw, options?.cwd, options?.home);
  const check = operation === "read" ? defaultPolicy.read : defaultPolicy.write;
  return lattice([check(prepared), check(prepared.toLowerCase())]);
}
