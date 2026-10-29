/**
 * Acknowledgements: a flag (`needsAcknowledgement`) that forces a human "yes, I know" before a call
 * runs, even when the verdict is allow. Not a tier: `block` stays block, a denial stays a denial.
 *
 * Flags come from the `authorization.acknowledge` block of any layer, and from `needsAcknowledgement`
 * on a specific rule. They are a union across layers: any layer may add one (adding tightens), and a
 * project file can never remove one. Only a user, session or managed layer may cancel a flag of a
 * weaker layer (`remove: true`).
 *
 * A stored acknowledgement is a grant-shaped row (`kind: "ack"`) with the same scopes, TTL and revoke.
 * Pure. The daemon computes which rows cover a call at floor time (it needs a clock) and stamps the
 * result on the job (`ackState`).
 */
import type { AckFlagInput, AckMatch, AuthMode, AuthorizationConfig, ClassId } from "./config.js";
import { type GrantRow, type GrantSubject, grantLabel, rowKind, sameSubject } from "./grants.js";
import type { LayerName, Layers } from "./resolve.js";

export type AckState = "none" | "pending" | "satisfied" | "refused";

/** Who said yes: `human` is the person who answered this one prompt; otherwise stored ack ids. */
export const ACKED_ONCE = "human";

export type AckFlag = {
  readonly match: AckMatch;
  readonly why?: string;
  readonly modes?: readonly AuthMode[];
  readonly layer: LayerName;
};

const WEAKER: Readonly<Record<string, number>> = { dist: 0, user: 1, session: 2, managed: 3 };

function canonical(match: AckMatch): string {
  return JSON.stringify(Object.fromEntries(Object.entries(match).toSorted(([a], [b]) => a.localeCompare(b))));
}

function ruleFlags(cfg: AuthorizationConfig, layer: LayerName): AckFlag[] {
  const out: AckFlag[] = [];
  for (const rule of cfg.rules ?? []) {
    if (rule.needsAcknowledgement !== true) continue;
    const match = rule.match;
    if ("mcp" in match) {
      out.push({
        match: {
          mcp: match.mcp,
          ...(match.account === undefined ? {} : { account: match.account }),
          ...(match.tool === undefined ? {} : { tool: match.tool }),
        },
        layer,
        ...(rule.note === undefined ? {} : { why: rule.note }),
      });
    } else if ("command" in match) {
      out.push({ match: { command: match.command }, layer, ...(rule.note === undefined ? {} : { why: rule.note }) });
    } else if ("tool" in match) {
      out.push({ match: { tool: match.tool }, layer, ...(rule.note === undefined ? {} : { why: rule.note }) });
    }
  }
  return out;
}

function layerFlags(cfg: AuthorizationConfig | undefined, layer: LayerName): { add: AckFlag[]; remove: AckMatch[] } {
  const add: AckFlag[] = [];
  const remove: AckMatch[] = [];
  if (cfg === undefined) return { add, remove };
  for (const entry of cfg.acknowledge ?? []) {
    if (entry.remove === true) remove.push(entry.match);
    else
      add.push({
        match: entry.match,
        layer,
        ...(entry.why === undefined ? {} : { why: entry.why }),
        ...(entry.modes === undefined ? {} : { modes: entry.modes }),
      });
  }
  add.push(...ruleFlags(cfg, layer));
  return { add, remove };
}

/**
 * Every flag in force across the layers. `remove` entries cancel an identical flag of a layer with less
 * authority (dist < user < session < managed). A project file and `managed.require` only add.
 */
export function collectAckFlags(layers: Layers): AckFlag[] {
  const sources: ReadonlyArray<readonly [LayerName, AuthorizationConfig | undefined]> = [
    ["dist", layers.dist],
    ["user", layers.user],
    ["session", layers.session],
    ["managed", layers.managedSet],
    ["managed", layers.managedRequire],
    ["project", layers.project],
  ];
  const adds: AckFlag[] = [];
  const removals: Array<{ rank: number; key: string }> = [];
  for (const [layer, cfg] of sources) {
    const { add, remove } = layerFlags(cfg, layer);
    adds.push(...add);
    // A project file (and a managed `require`) never cancels a flag.
    if (layer !== "project" && cfg !== layers.managedRequire) {
      for (const match of remove) removals.push({ rank: WEAKER[layer]!, key: canonical(match) });
    }
  }
  const seen = new Set<string>();
  const out: AckFlag[] = [];
  for (const flag of adds) {
    const key = canonical(flag.match);
    // Only layers with less authority than the remover are cancelled; project flags are never cancelled.
    const rank = flag.layer === "project" ? Infinity : WEAKER[flag.layer]!;
    if (removals.some((removal) => removal.key === key && removal.rank > rank)) continue;
    const dedupe = `${key}\0${flag.layer}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    out.push(flag);
  }
  return out;
}

export type AckUnit = {
  readonly argv0: string;
  readonly spine: readonly string[];
  readonly familyArgs: readonly string[];
};

/** The call as the flags see it. `classes` are the floor's classes (an approved call has none). */
export type AckCall = {
  readonly classes: readonly ClassId[];
  readonly mcp?: { readonly server: string; readonly account: string; readonly tool: string };
  readonly tool: string;
  readonly units: readonly AckUnit[];
};

/** A flag that covers this call, as the job carries and the prompt shows it. */
export type MatchedAck = {
  readonly label: string;
  readonly why?: string;
  readonly layer: LayerName;
  readonly match: AckMatch;
  readonly modes?: readonly AuthMode[];
  /** Command flags: the shell unit that matched. */
  readonly unit?: AckUnit;
};

export function ackMatchLabel(match: AckMatch): string {
  if ("class" in match) return `any ${match.class} call`;
  if ("mcp" in match) {
    const account = match.account === undefined ? "" : ` (${match.account})`;
    return `${match.mcp}${account} · ${match.tool ?? "every tool"}`;
  }
  if ("tool" in match) return `tool ${match.tool}`;
  return `\`${match.command.join(" ")}\``;
}

function unitTokens(unit: AckUnit): string[] {
  return [unit.argv0, ...unit.spine, ...unit.familyArgs];
}

function isPrefix(prefix: readonly string[], of: readonly string[]): boolean {
  return prefix.length <= of.length && prefix.every((part, i) => part === of[i]);
}

/** The flags that cover the call. Not filtered by mode: the mode can change while the call waits. */
export function matchAckFlags(flags: readonly AckFlag[], call: AckCall): MatchedAck[] {
  const out: MatchedAck[] = [];
  for (const flag of flags) {
    const base = {
      label: ackMatchLabel(flag.match),
      layer: flag.layer,
      match: flag.match,
      ...(flag.why === undefined ? {} : { why: flag.why }),
      ...(flag.modes === undefined ? {} : { modes: flag.modes }),
    };
    const match = flag.match;
    if ("class" in match) {
      if (call.classes.includes(match.class)) out.push(base);
    } else if ("mcp" in match) {
      const mcp = call.mcp;
      if (
        mcp !== undefined &&
        mcp.server === match.mcp &&
        (match.account === undefined || mcp.account === match.account) &&
        (match.tool === undefined || mcp.tool === match.tool)
      ) {
        out.push(base);
      }
    } else if ("tool" in match) {
      if (call.tool === match.tool) out.push(base);
    } else {
      const unit = call.units.find((candidate) => isPrefix(match.command, unitTokens(candidate)));
      if (unit !== undefined) out.push({ ...base, unit });
    }
  }
  return out;
}

/** The flags that prompt in this mode (a flag with no `modes` prompts in every mode, yolo included). */
export function activeAcks(matched: readonly MatchedAck[], mode: AuthMode): MatchedAck[] {
  return matched.filter((m) => m.modes === undefined || m.modes.includes(mode));
}

/** The subject a flag's own match is stored as. */
export function ackSubjectOf(match: AckMatch): GrantSubject {
  if ("class" in match) return { kind: "class", class: match.class };
  if ("mcp" in match) {
    return {
      kind: "mcp",
      server: match.mcp,
      ...(match.account === undefined ? {} : { account: match.account }),
      ...(match.tool === undefined ? {} : { tool: match.tool }),
    };
  }
  if ("tool" in match) return { kind: "tool", name: match.tool };
  const [argv0, ...rest] = match.command;
  return { kind: "command", argv0: argv0!, spine: rest, args: [] };
}

function subjectTokens(subject: Extract<GrantSubject, { kind: "command" }>): string[] {
  return [subject.argv0, ...subject.spine, ...subject.args];
}

/** Does a stored ack satisfy the flag for this call? It must cover the call and be no broader than the flag. */
function rowSatisfies(row: GrantRow, matched: MatchedAck, call: AckCall): boolean {
  const subject = row.subject;
  const match = matched.match;
  if ("class" in match) return subject.kind === "class" && subject.class === match.class;
  if ("mcp" in match) {
    const mcp = call.mcp;
    if (subject.kind !== "mcp" || mcp === undefined || subject.server !== match.mcp) return false;
    if (match.tool !== undefined && subject.tool !== match.tool) return false;
    if (match.account !== undefined && subject.account !== match.account) return false;
    return (
      (subject.account === undefined || subject.account === mcp.account) &&
      (subject.tool === undefined || subject.tool === mcp.tool)
    );
  }
  if ("tool" in match) return subject.kind === "tool" && subject.name === match.tool;
  const unit = matched.unit;
  if (subject.kind !== "command" || unit === undefined) return false;
  const tokens = subjectTokens(subject);
  return isPrefix(match.command, tokens) && isPrefix(tokens, unitTokens(unit));
}

export type AckResolution = {
  readonly state: "none" | "pending" | "satisfied";
  /** Ids of the stored acks that cover every active flag. */
  readonly ackedBy: readonly string[];
};

/**
 * Where a call stands: no active flag (`none`), every active flag covered by a stored ack (`satisfied`),
 * or `pending`. `rows` are the acks visible to the session (live and in scope); other kinds are ignored.
 */
export function resolveAcks(
  active: readonly MatchedAck[],
  rows: readonly GrantRow[],
  call: AckCall,
): AckResolution {
  if (active.length === 0) return { state: "none", ackedBy: [] };
  const acks = rows.filter((row) => rowKind(row) === "ack");
  const used: string[] = [];
  for (const matched of active) {
    const row = acks.find((candidate) => rowSatisfies(candidate, matched, call));
    if (row === undefined) return { state: "pending", ackedBy: [] };
    if (!used.includes(row.id)) used.push(row.id);
  }
  return { state: "satisfied", ackedBy: used };
}

export type AckOption = { readonly subject: GrantSubject; readonly label: string };

/**
 * What a prompt may offer to remember: each flag's own match, plus a narrower subject for this call
 * (an MCP flag on a whole server offers the tool; a command flag offers the unit's family). The daemon
 * recomputes this to validate the `store.subject` a client sends.
 */
export function ackOptionsFor(active: readonly MatchedAck[], call: AckCall): AckOption[] {
  const out: AckOption[] = [];
  const add = (subject: GrantSubject): void => {
    if (!out.some((option) => sameSubject(option.subject, subject))) out.push({ subject, label: grantLabel(subject) });
  };
  for (const matched of active) {
    const own = ackSubjectOf(matched.match);
    const match = matched.match;
    if ("mcp" in match && call.mcp !== undefined) {
      if (match.tool === undefined) {
        add({ kind: "mcp", server: call.mcp.server, account: call.mcp.account, tool: call.mcp.tool });
      }
      add(own);
    } else if ("command" in match && matched.unit !== undefined) {
      add(own);
      const narrow: GrantSubject = {
        kind: "command",
        argv0: matched.unit.argv0,
        spine: [...matched.unit.spine],
        args: [...matched.unit.familyArgs],
      };
      add(narrow);
    } else {
      add(own);
    }
  }
  return out;
}

/** The flags of a stamped job, or []. */
export function parseMatchedAcks(json: string | null | undefined): MatchedAck[] {
  if (json == null || json === "") return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as MatchedAck[]) : [];
  } catch {
    return [];
  }
}

export type { AckFlagInput };
