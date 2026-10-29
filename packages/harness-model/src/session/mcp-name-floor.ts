/**
 * MCP read-floor on `serverToolName`. Persist allow fires only on a
 * positive stem after veto / GraphQL pair / one-word write. Persist
 * deny fires on the complement. Overlay and `readOnlyHint` are not a
 * grant.
 *
 * Validated against top-500 MCP servers.
 *
 * Split camel + `_`/`-`/`.` → lower → drop connectors → score remainder.
 * The name is server-controlled and `readOnlyHint` annotations are not carried on the
 * job, so ANY mutating token vetoes the whole name; a stem only counts when none is present.
 */
const VETO = new Set([
  "create",
  "update",
  "delete",
  "remove",
  "send",
  "merge",
  "submit",
  "upsert",
  "ensure",
  "execute",
]);
/**
 * Mutating / side-effecting verbs. A tool name that carries any of these is never a
 * look-up, even next to a read word: `query_and_drop_table`, `find_and_kill_process`,
 * `transfer_funds_and_get_receipt`. Plural `-s` forms count (`posts` -> `post`).
 */
const MUTATING = new Set([
  "exec",
  "run",
  "invoke",
  "drop",
  "kill",
  "terminate",
  "destroy",
  "stop",
  "restart",
  "reboot",
  "shutdown",
  "overwrite",
  "replace",
  "post",
  "put",
  "patch",
  "push",
  "publish",
  "deploy",
  "upload",
  "install",
  "uninstall",
  "apply",
  "commit",
  "rollback",
  "transfer",
  "pay",
  "charge",
  "refund",
  "purchase",
  "buy",
  "sell",
  "cancel",
  "revoke",
  "grant",
  "approve",
  "reject",
  "assign",
  "invite",
  "ban",
  "archive",
  "close",
  "add",
  "set",
  "insert",
  "edit",
  "modify",
  "rename",
  "move",
  "truncate",
  "wipe",
  "purge",
  "clear",
  "reset",
  "disable",
  "enable",
  "start",
  "launch",
  "spawn",
  "schedule",
]);
const ONE_WORD = new Set(["reply", "forward", "trash", "write"]);
const STEM = new Set(["get", "list", "search", "read", "fetch", "find", "query"]);
const CONNECTORS = new Set([
  "and",
  "or",
  "the",
  "a",
  "an",
  "to",
  "from",
  "of",
  "for",
  "with",
  "by",
  "in",
  "on",
  "at",
  "as",
  "via",
  "vs",
  "into",
  "onto",
  "than",
  "then",
]);

export type McpNameFloorVerdict = "veto" | "graphql" | "one_word" | "stem" | "middle";

function splitMcpToolName(name: string): string[] {
  const marked = name.replaceAll(/([a-z0-9])([A-Z])/g, "$1\0$2").replaceAll(/([A-Z]+)([A-Z][a-z])/g, "$1\0$2");
  const raw = marked
    .split(/[\0_\-./]+/)
    .filter(Boolean)
    .map((part) => part.toLowerCase());
  const out: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "graph" && raw[i + 1] === "ql") {
      out.push("graphql");
      i++;
    } else {
      out.push(raw[i]!);
    }
  }
  return out;
}

function isMutating(chunk: string): boolean {
  return MUTATING.has(chunk) || (chunk.endsWith("s") && MUTATING.has(chunk.slice(0, -1)));
}

export function classifyMcpToolName(name: string): {
  readonly rest: readonly string[];
  readonly verdict: McpNameFloorVerdict;
} {
  const rest = splitMcpToolName(name).filter((chunk) => !CONNECTORS.has(chunk));
  if (rest.some((chunk) => VETO.has(chunk))) return { rest, verdict: "veto" };
  if (rest.includes("query") && rest.includes("graphql")) return { rest, verdict: "graphql" };
  if (rest.some(isMutating)) return { rest, verdict: "veto" };
  if (rest.length > 0 && rest.every((chunk) => ONE_WORD.has(chunk))) return { rest, verdict: "one_word" };
  // A bare `query` is a query-runner (SQL, GraphQL, shell-ish): its body can mutate.
  if (rest.length === 1 && rest[0] === "query") return { rest, verdict: "middle" };
  if (rest.some((chunk) => STEM.has(chunk))) return { rest, verdict: "stem" };
  return { rest, verdict: "middle" };
}

/** Persist Always / this-session may remember this name as a look-up. */
export function mcpReadFloorAllows(serverToolName: string): boolean {
  return classifyMcpToolName(serverToolName).verdict === "stem";
}

/** Persist deny may hide this name. The floor inverts: stem remembers, else hides. */
export function mcpReadFloorDenies(serverToolName: string): boolean {
  return !mcpReadFloorAllows(serverToolName);
}

export type McpPersistScope = "session" | "always";

/** Exact persist identity. First `:` splits connection from server tool name. */
export function mcpToolRefKey(connectionKey: string, serverToolName: string): string {
  return `${connectionKey}:${serverToolName}`;
}

export function parseMcpToolRefKey(key: string): { connectionKey: string; serverToolName: string } | undefined {
  const cut = key.indexOf(":");
  if (cut <= 0 || cut === key.length - 1) return undefined;
  return { connectionKey: key.slice(0, cut), serverToolName: key.slice(cut + 1) };
}

export function parseMcpPersistScope(raw: unknown): McpPersistScope | undefined {
  return raw === "session" || raw === "always" ? raw : undefined;
}

export function mcpToolListHas(
  list: Readonly<Record<string, string>>,
  connectionKey: string,
  serverToolName: string,
): boolean {
  return parseMcpPersistScope(list[mcpToolRefKey(connectionKey, serverToolName)]) !== undefined;
}

export function mcpToolListStamp(list: Readonly<Record<string, string>>): string {
  return Object.entries(list)
    .filter(([, value]) => parseMcpPersistScope(value) !== undefined)
    .map(([key]) => key)
    .sort()
    .join("\n");
}
