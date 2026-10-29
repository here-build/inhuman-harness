/**
 * REPL/watch wire names, period token, and argument schemas.
 * Interpreter and builtin registration import these; they do not live on executors.
 */
import { PERIOD_ERR, PERIOD_TOKEN } from "../schemas/scheme-repl.js";

/** The outer tool name is never rebound inside itself. */
export const SCHEME_REPL_TOOL_NAME = "scheme_repl";
export const SCHEME_WATCH_TOOL_NAME = "scheme_watch";

/** Door `ToolNaming` for this host — not manifold's single MCP tool. */
export const SCHEME_REPL_NAMING = {
  toolName: SCHEME_REPL_TOOL_NAME,
  argName: "expr",
} as const;

export const DONE_CONDITION = "meta-reactivity/done-condition";
export const PERIOD_BREAKER_ERR =
  "scheme_watch requires a reachable (meta-reactivity/done-condition pred [result]) in expr. For one-shot work, use scheme_repl without period instead. For monitoring, use the requested stopping predicate, or #f to continue until cancelled; do not add constant true merely to satisfy validation.";

export function periodMsOf(value: string): number {
  const matched = PERIOD_TOKEN.exec(value.trim());
  if (matched == null) throw new Error(PERIOD_ERR);
  const n = Number(matched[1]);
  switch (matched[2]) {
    case "minutes":
      return n * 60_000;
    case "hours":
      return n * 3_600_000;
    default:
      return n * 86_400_000;
  }
}
