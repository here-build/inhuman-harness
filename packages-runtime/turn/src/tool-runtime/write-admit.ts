/**
 * write_file overwrite gate and admit snapshot. Effect bodies stay
 * outside this package; this is the door the guard still sees.
 */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

import { parseJsonRecord } from "@inhuman.tools/harness-model/json-record";

const MAX_FILE_READ_BYTES = 4 * 1024 * 1024;

const OVERWRITE_EXISTING_DOOR =
  "tried to overwrite the existing file, use write_file with the overwriteExisting flag if you need that to happen";

export function overwriteExistingDoor(pathText: string): string {
  return `write_file: ${pathText} exists — ${OVERWRITE_EXISTING_DOOR}`;
}

/** True only for boolean true or the string "true". Missing / false → door on exist. */
export function overwriteExistingOf(args: unknown): boolean {
  if (args == null || typeof args !== "object") return false;
  const rec = args as Record<string, unknown>;
  const value = rec.overwriteExisting ?? rec.overwrite_existing ?? rec.overwrite;
  return value === true || value === "true";
}

/** Tape line annotation. Line 1 is omitted. */
export function lineStartOfSpan(file: string | null | undefined, span: string): number | null {
  if (file == null || span === "") return null;
  let idx = file.indexOf(span);
  if (idx === -1) {
    const firstLine = span.split("\n")[0] ?? "";
    if (firstLine === "" || firstLine === span) return null;
    idx = file.indexOf(firstLine);
  }
  if (idx === -1) return null;
  let line = 1;
  for (let i = 0; i < idx; i++) if (file[i] === "\n") line++;
  return line <= 1 ? null : line;
}

/** NUL-free UTF-8 under the read budget. Empty file is "". */
export function priorTextSync(target: string): string | null {
  try {
    const info = statSync(target);
    if (!info.isFile() || info.size > MAX_FILE_READ_BYTES) return null;
    const buf = readFileSync(target);
    if (buf.includes(0)) return null;
    return buf.toString("utf8");
  } catch {
    return null;
  }
}

type WriteAdmitSnap = {
  /** `null` means we could not tell — not a definite miss. */
  readonly existed: boolean | null;
  readonly priorContent: string | null;
  readonly refuse: string | null;
};

function insideRoot(root: string, file: string): boolean {
  const from = path.relative(root, file);
  return from === "" || (!from.startsWith("..") && !path.isAbsolute(from));
}

/**
 * Admit runs before any license. Only a path that stays inside the workspace, links resolved, may
 * be read or probed here; anything else is left to the licensed body, which captures prior content
 * after approval and keeps the overwrite door.
 */
export function writeFileAdmitSnap(root: string, argsJson: string): WriteAdmitSnap {
  const args = parseJsonRecord(argsJson === "" ? "{}" : argsJson);
  const raw = args !== null && typeof args.path === "string" ? args.path : "";
  if (raw.trim() === "") return { existed: null, priorContent: null, refuse: null };
  const target = path.resolve(root, raw);
  const unknown: WriteAdmitSnap = { existed: null, priorContent: null, refuse: null };
  try {
    const realRoot = realpathSync(root);
    if (!insideRoot(path.resolve(root), target)) return unknown;
    if (existsSync(target) && !insideRoot(realRoot, realpathSync(target))) return unknown;
    if (!existsSync(target)) return { existed: false, priorContent: null, refuse: null };
    if (!statSync(target).isFile()) return { existed: null, priorContent: null, refuse: null };
  } catch {
    return { existed: null, priorContent: null, refuse: null };
  }
  const priorContent = priorTextSync(target);
  const refuse = overwriteExistingOf(args ?? {}) ? null : overwriteExistingDoor(raw);
  return { existed: true, priorContent, refuse };
}
