/**
 * write_file overwrite gate. Existing path requires overwriteExisting.
 * Host snapshot of prior text (no NUL, under the read budget) for the tape Diff.
 * Binary / too large → null (overwrite still allowed with the flag).
 */
import { readFileSync, statSync } from "node:fs";

import { z } from "@inhuman.tools/plugin-sdk";

import { MAX_FILE_READ_BYTES } from "./bounds.js";

export const OVERWRITE_EXISTING_DOOR =
  "tried to overwrite the existing file, use write_file with the overwriteExisting flag if you need that to happen";

export function overwriteExistingDoor(pathText: string): string {
  return `write_file: ${pathText} exists — ${OVERWRITE_EXISTING_DOOR}`;
}

/** True only for boolean true or the string "true". Missing / false → door on exist. */
export function overwriteExistingOf(args: unknown): boolean {
  const parsed = z
    .unknown()
    .transform((value) => {
      if (typeof value !== "object" || value === null) return undefined;
      const row = value as Record<string, unknown>;
      return row.overwriteExisting ?? row.overwrite_existing ?? row.overwrite;
    })
    .pipe(z.union([z.literal(true), z.literal("true")]))
    .safeParse(args);
  return parsed.success;
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
