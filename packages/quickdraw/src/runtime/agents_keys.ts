/**
 * Drawer row keys are `session:<id>`, `call:<id>`, `bot:<id>`. Paint
 * children append a suffix (`:name`, `:id-line`, …). Hits report the
 * child; restore / hover want the row key.
 */

const SESSION_PREFIX = "session:";
const ROW = /^(session|call|bot):/;
const CHILD = /(?::name|:id-line|:id-row|:id|:title|:mark|:status|:recap|:indent|:dive:\d+)$/;

export function agentsRowKeyFromHit(key: string): string | null {
  if (key.includes(":gap:") || !ROW.test(key)) return null;
  let cur = key;
  while (CHILD.test(cur)) cur = cur.replace(CHILD, "");
  return ROW.test(cur) && cur !== "session:" && cur !== "call:" && cur !== "bot:" ? cur : null;
}

export function sessionIdFromAgentsKey(key: string): string | null {
  const row = agentsRowKeyFromHit(key);
  if (!row?.startsWith(SESSION_PREFIX)) return null;
  const id = row.slice(SESSION_PREFIX.length).trim();
  return id === "" ? null : id;
}
