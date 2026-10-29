/**
 * Tables for describe.each / it.each.
 *
 * Prefer `describe.each(await availableTerminalsTable())` with top-level await
 * so missing apps are omitted. Or use `TERMINALS_TABLE` + `it.skipIf(!available)`.
 */

import { isDarwin } from "../mac.js";
import { listAvailableTerminals, type TerminalMeta } from "../terminals.js";

/**
 * Only terminals installed on this machine. Empty on non-darwin.
 * Safe for `describe.each` / `it.each` after top-level await.
 */
export async function availableTerminalsTable(): Promise<TerminalMeta[]> {
  if (!isDarwin()) return [];
  return listAvailableTerminals();
}
