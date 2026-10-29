/**
 * Epoch / turn identity for remainder skip.
 * `allow` lasts until userEpoch changes; `deny` lasts for the owning turn.
 * Live skip votes are process-local on LicenseScope. Not policy.json.
 */
import type { ToolCallJob } from "./jobs/ToolCallJob.js";
import type { SessionRoot } from "./SessionRoot.js";
import { SessionTurn } from "./turn/session-turn.js";
import type { SessionUnit } from "./turn/types.js";

/** SessionTurn nodes from head along `.turnTail` whose `prompt` is non-blank. */
export function userEpoch(root: SessionRoot): number {
  let n = 0;
  const seen = new Set<SessionTurn>();
  let unit: SessionUnit | null = root.head;
  while (unit instanceof SessionTurn) {
    if (seen.has(unit)) break;
    seen.add(unit);
    if (unit.prompt.trim() !== "") n += 1;
    unit = unit.turnTail;
  }
  return n;
}

/** Plexus identity of the nearest parent SessionTurn, or null if unhomed. */
export function owningTurnId(job: ToolCallJob): string | null {
  const seen = new Set<object>();
  let node: { parent: unknown } | null = job;
  while (node != null) {
    if (seen.has(node)) return null;
    seen.add(node);
    const parent: unknown = node.parent;
    if (parent instanceof SessionTurn) return parent.__doc__ == null ? null : parent.uuid;
    node = parent !== null && typeof parent === "object" && "parent" in parent ? (parent as { parent: unknown }) : null;
  }
  return null;
}
