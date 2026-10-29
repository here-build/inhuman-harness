/**
 * Grants: a stored human "yes" to an ask, by family. Soft-deny is never stored; a grant never lifts
 * `deny` or `block`, and never covers a lifted ask (env-prefix, xargs, non-literal, unparsed), a
 * hatch, or anything the floor could not identify.
 *
 * Pure. The daemon computes `grantedBy` at floor time (the clock matters) and stamps it on the job.
 */
import { z } from "zod";

import { CLASS_IDS } from "./config.js";

export const GRANT_SCOPES = ["session", "project", "bot", "global"] as const;
export type GrantScope = (typeof GRANT_SCOPES)[number];

const commandSubject = z
  .object({
    kind: z.literal("command"),
    argv0: z.string().min(1),
    spine: z.array(z.string()),
    args: z.array(z.string()),
  })
  .strict();
const pathSubject = z
  .object({
    kind: z.literal("path"),
    cluster: z.enum(["read", "write"]),
    path: z.string().min(1),
    depth: z.enum(["exact", "subtree"]),
  })
  .strict();
/** `account` is the connection id: one ConnectionSpec is one account. */
const mcpSubject = z
  .object({
    kind: z.literal("mcp"),
    server: z.string().min(1),
    account: z.string().min(1).optional(),
    tool: z.string().min(1).optional(),
  })
  .strict();
const toolSubject = z.object({ kind: z.literal("tool"), name: z.string().min(1) }).strict();
/** Acks only: "any call of this class". A grant never has this subject. */
const classSubject = z.object({ kind: z.literal("class"), class: z.enum(CLASS_IDS) }).strict();

export const grantSubjectSchema = z.discriminatedUnion("kind", [
  commandSubject,
  pathSubject,
  mcpSubject,
  toolSubject,
  classSubject,
]);
export type GrantSubject = z.infer<typeof grantSubjectSchema>;

export const grantRowSchema = z
  .object({
    id: z.string().min(1),
    /** Absent: a grant (a stored "yes" to an ask). `ack`: a stored acknowledgement (a flag's "yes, I know"). */
    kind: z.enum(["grant", "ack"]).optional(),
    scope: z.enum(GRANT_SCOPES),
    /** sessionId | project path | bot name | "" */
    scopeKey: z.string(),
    subject: grantSubjectSchema,
    createdAtMs: z.number().int(),
    expiresAtMs: z.number().int().nullable(),
    source: z.enum(["prompt", "settings"]),
    label: z.string(),
  })
  .strict();
export type GrantRow = z.infer<typeof grantRowSchema>;

export function rowKind(row: GrantRow): "grant" | "ack" {
  return row.kind ?? "grant";
}

export function parseGrantRows(json: string | null | undefined): GrantRow[] {
  if (json == null || json.trim() === "") return [];
  try {
    const parsed = z.array(grantRowSchema).safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

export function grantLabel(subject: GrantSubject): string {
  switch (subject.kind) {
    case "command": {
      const family = [subject.argv0, ...subject.spine, ...subject.args].join(" ");
      return `\`${family}\` (any other arguments)`;
    }
    case "path":
      return `${subject.cluster} ${subject.path}${subject.depth === "subtree" ? "/ (everything under it)" : ""}`;
    case "mcp":
      return `${subject.server}${subject.account === undefined ? "" : ` (${subject.account})`} · ${subject.tool ?? "every tool"}`;
    case "tool":
      return `tool ${subject.name}`;
    case "class":
      return `any ${subject.class} call`;
  }
}

export function isLive(row: GrantRow, nowMs: number): boolean {
  return row.expiresAtMs === null || row.expiresAtMs > nowMs;
}

/** What a session may see: its own rows, its project's, its bot's, and the global ones. Expired rows are dropped. */
export function visibleRows(
  rows: readonly GrantRow[],
  who: { readonly sessionId: string; readonly projectPath: string; readonly bot?: string },
  nowMs: number,
): GrantRow[] {
  return rows.filter((row) => {
    if (!isLive(row, nowMs)) return false;
    switch (row.scope) {
      case "session":
        return row.scopeKey === who.sessionId;
      case "project":
        return row.scopeKey === who.projectPath;
      case "bot":
        return who.bot !== undefined && row.scopeKey === who.bot;
      case "global":
        return true;
    }
  });
}

const TTL_UNITS: Readonly<Record<string, number>> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** `"7d"` → ms. `null`, absent or malformed → no expiry. */
export function parseTtl(text: string | null | undefined): number | null {
  if (text == null) return null;
  const match = /^(\d+)([smhd])$/.exec(text);
  return match === null ? null : Number(match[1]) * TTL_UNITS[match[2]!]!;
}

/** Prompt defaults: session grants end with the session; the rest last seven days. */
export const DEFAULT_PROMPT_TTL: Readonly<Record<GrantScope, string | null>> = {
  session: null,
  project: "7d",
  bot: "7d",
  global: "7d",
};

/** What the floor said about the call, as the grant check needs it. */
export type GrantCall = {
  readonly tier: "policyApprove" | "ask" | "deny" | "block" | null;
  readonly cluster: "bash" | "read" | "write" | "mcp";
  readonly hatch: boolean;
  readonly votes: readonly GrantVote[];
  readonly mcp?: { readonly server: string; readonly account: string; readonly tool: string };
  readonly toolName: string;
};

export type GrantVote = {
  readonly disposition: string;
  readonly lift?: string;
  readonly unit?: { readonly argv0: string; readonly spine: readonly string[]; readonly familyArgs: readonly string[] };
  readonly path?: { readonly cluster: "read" | "write"; readonly path: string };
};

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function pathCovered(
  subject: Extract<GrantSubject, { kind: "path" }>,
  cluster: "read" | "write",
  path: string,
): boolean {
  if (subject.cluster !== cluster) return false;
  if (subject.path === path) return true;
  if (subject.depth !== "subtree" || fencedSubtree(subject.cluster, subject.path)) return false;
  return path.startsWith(`${subject.path.replace(/\/+$/, "")}/`);
}

/** A subtree grant of the workspace root, a volume root, `$HOME` or a one-segment path is never a blanket. */
export function fencedSubtree(cluster: "read" | "write", path: string): boolean {
  const trimmed = path.replace(/\/+$/, "");
  if (trimmed === "." && cluster === "write") return false;
  if (trimmed === "" || trimmed === "." || trimmed === "~" || trimmed === "$HOME" || trimmed.startsWith("~/"))
    return true;
  const segments = trimmed.split("/").filter((segment) => segment !== "");
  if (trimmed.startsWith("/")) return segments.length <= 1;
  return segments.length <= 1;
}

function voteCovered(vote: GrantVote, rows: readonly GrantRow[]): GrantRow | undefined {
  if (vote.lift !== undefined) return undefined;
  if (vote.path !== undefined) {
    const { cluster, path } = vote.path;
    return rows.find((row) => row.subject.kind === "path" && pathCovered(row.subject, cluster, path));
  }
  const unit = vote.unit;
  if (unit === undefined) return undefined;
  return rows.find(
    (row) =>
      row.subject.kind === "command" &&
      row.subject.argv0 === unit.argv0 &&
      sameList(row.subject.spine, unit.spine) &&
      row.subject.args.length <= unit.familyArgs.length &&
      row.subject.args.every((arg, i) => arg === unit.familyArgs[i]),
  );
}

/**
 * The grants that cover this call, or null. Only a tier `ask` is ever covered. Every ask vote must be
 * covered by some grant (a pipeline needs each of its ask units).
 */
export function coveringGrants(rows: readonly GrantRow[], call: GrantCall): GrantRow[] | null {
  if (call.tier !== "ask" || call.hatch) return null;
  if (call.cluster === "mcp") {
    if (call.mcp === undefined) {
      const row = rows.find((r) => r.subject.kind === "tool" && r.subject.name === call.toolName);
      return row === undefined ? null : [row];
    }
    const mcp = call.mcp;
    const row = rows.find(
      (r) =>
        r.subject.kind === "mcp" &&
        r.subject.server === mcp.server &&
        (r.subject.account === undefined || r.subject.account === mcp.account) &&
        (r.subject.tool === undefined || r.subject.tool === mcp.tool),
    );
    return row === undefined ? null : [row];
  }
  const asks = call.votes.filter((vote) => vote.disposition === "ask");
  if (asks.length === 0) return null;
  const used: GrantRow[] = [];
  for (const vote of asks) {
    const row = voteCovered(vote, rows);
    if (row === undefined) return null;
    if (!used.includes(row)) used.push(row);
  }
  return used;
}

export type GrantOption = { readonly subject: GrantSubject; readonly label: string };

function parentOf(path: string): string | undefined {
  const at = path.lastIndexOf("/");
  return at <= 0 ? undefined : path.slice(0, at);
}

/**
 * What a prompt may offer to remember. Never for soft-deny, block, hatch or a lifted ask. A pipeline of
 * several ask families offers nothing: a grant is one family. The daemon recomputes this to validate
 * the `store.subject` a client sends.
 */
export function grantOptionsFor(call: GrantCall): GrantOption[] {
  if (call.tier !== "ask" || call.hatch) return [];
  const make = (subject: GrantSubject): GrantOption => ({ subject, label: grantLabel(subject) });
  if (call.cluster === "mcp") {
    if (call.mcp === undefined) return [make({ kind: "tool", name: call.toolName })];
    return [make({ kind: "mcp", server: call.mcp.server, account: call.mcp.account, tool: call.mcp.tool })];
  }
  const asks = call.votes.filter((vote) => vote.disposition === "ask");
  if (asks.length === 0 || asks.some((vote) => vote.lift !== undefined)) return [];
  const paths = asks.filter((vote) => vote.path !== undefined);
  if (paths.length > 0) {
    if (paths.length !== asks.length) return [];
    const distinct = new Set(paths.map((vote) => `${vote.path!.cluster}\0${vote.path!.path}`));
    if (distinct.size !== 1) return [];
    const { cluster, path } = paths[0]!.path!;
    if (path.includes("*") || path.includes("$") || path.includes("~")) return [];
    const out: GrantOption[] = [make({ kind: "path", cluster, path, depth: "exact" })];
    const parent = parentOf(path);
    if (parent !== undefined && !fencedSubtree(cluster, parent)) {
      out.push(make({ kind: "path", cluster, path: parent, depth: "subtree" }));
    }
    return out;
  }
  const units = new Map<string, NonNullable<GrantVote["unit"]>>();
  for (const vote of asks) {
    if (vote.unit === undefined) return [];
    units.set(JSON.stringify(vote.unit), vote.unit);
  }
  if (units.size !== 1) return [];
  const unit = [...units.values()][0]!;
  return [make({ kind: "command", argv0: unit.argv0, spine: [...unit.spine], args: [...unit.familyArgs] })];
}

function canonical(subject: GrantSubject): string {
  return JSON.stringify(Object.fromEntries(Object.entries(subject).toSorted(([a], [b]) => a.localeCompare(b))));
}

export function sameSubject(a: GrantSubject, b: GrantSubject): boolean {
  return canonical(a) === canonical(b);
}
