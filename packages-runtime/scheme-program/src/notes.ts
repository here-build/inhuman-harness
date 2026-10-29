import type { TopLevelSplice } from "@inhuman.tools/substrate/unwrap-begin";

/** Own tool text part per spliced wrapper spelling. Not a statement value. */
export const SCHEME_REPL_UNWRAP_NOTES = {
  begin: ";; unwrapped (begin …): each statement is returned as its own result. Write consecutive top-level forms.",
  list: ";; unwrapped (list …): each statement is returned as its own result. Write consecutive top-level forms.",
  vector: ";; unwrapped []: each statement is returned as its own result. Write consecutive top-level forms.",
} as const satisfies Record<TopLevelSplice, string>;

/** Attached to a top-level statement that was a `(display X)` — the rewrite unwrapped it to X and
 *  X's value IS the answer block, so this teaches that the display spelling was unnecessary:
 *  scheme_repl already returns each top-level statement as its own tool response. scheme_watch is
 *  repl-only and does not surface per-statement responses, so it does not attach this note. */
export const SCHEME_REPL_DISPLAY_NOTE =
  ";; you do not need to use (display ...) — each top-level statement of scheme_repl is written as a tool response";
