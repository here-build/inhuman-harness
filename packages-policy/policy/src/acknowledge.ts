/**
 * `needsAcknowledgement` for the adapters. One place for the flag schema, the matcher and the texts;
 * an adapter only asks "does this call need an acknowledgement" and translates the answer into its
 * host's confirmation mechanism.
 *
 * A flag forces a request for a call that would otherwise run (floor approve, judge allow, any
 * resolution to allow). It never turns a block or a denial into anything. Flags only tighten:
 * the effective set is the union of the user and project layers, so a project file can add and
 * can never remove a user flag. The dist ships none.
 *
 * Adapters have no `modes` of their own, so `modes` is accepted (the schema is the daemon's) and
 * ignored: a flag applies in every adapter.
 *
 * `class` matches the classes of the floor votes (`classesOf`). An approve has no classes, so a
 * class flag only matches a call whose floor tier is ask or deny. `command` matches a prefix of
 * `[argv0, ...spine, ...familyArgs]` of any shell unit in `verdict.seen`, so approved calls match.
 */
import { z } from "zod";

import { defaultPolicy } from "./bind.js";
import { CLASS_IDS, type ClassId } from "./classes.js";
import { lattice } from "./lift.js";
import { normalizeToolPath } from "./tool-path.js";
import { classesOf, type FloorVerdict } from "./types.js";
import { join } from "./verdict.js";

const classIdSchema = z.enum(CLASS_IDS);

const matchSchema = z.union([
  z.strictObject({ class: classIdSchema }),
  z.strictObject({ mcp: z.string().min(1), account: z.string().min(1).optional(), tool: z.string().min(1).optional() }),
  z.strictObject({ tool: z.string().min(1) }),
  z.strictObject({ command: z.array(z.string().min(1)).min(1) }),
]);

const flagSchema = z.strictObject({
  match: matchSchema,
  why: z.string().max(200).optional(),
  modes: z.array(z.enum(["manual", "auto", "yolo"])).optional(),
});

export type AckMatch =
  | { readonly class: ClassId }
  | { readonly mcp: string; readonly account?: string; readonly tool?: string }
  | { readonly tool: string }
  | { readonly command: readonly string[] };

export type AckFlag = {
  readonly match: AckMatch;
  readonly why?: string;
  readonly modes?: readonly ("manual" | "auto" | "yolo")[];
};

/** Throws a readable error for an invalid block; `undefined` is no flags. */
export function parseAcknowledge(value: unknown): readonly AckFlag[] {
  if (value === undefined) return [];
  const parsed = z.array(flagSchema).safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `invalid acknowledge config: ${issue === undefined ? "bad shape" : `${issue.path.join(".") || "(root)"}: ${issue.message}`}`,
    );
  }
  return parsed.data as readonly AckFlag[];
}

/** A config file's text: a JSON array of flags, or an object with an `acknowledge` array. Empty text is none. */
export function parseAcknowledgeText(text: string | undefined): readonly AckFlag[] {
  if (text === undefined || text.trim() === "") return [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("invalid acknowledge config: not json");
  }
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    return parseAcknowledge((raw as Record<string, unknown>).acknowledge);
  }
  return parseAcknowledge(raw);
}

/** Layer rule: the union. Project can add; nothing in it removes a user flag. */
export function mergeAcknowledge(...layers: readonly (readonly AckFlag[] | undefined)[]): readonly AckFlag[] {
  const out = new Map<string, AckFlag>();
  for (const layer of layers) for (const flag of layer ?? []) out.set(JSON.stringify([flag.match, flag.why]), flag);
  return [...out.values()];
}

/** `mcp__server__tool` is the common MCP tool-name shape; hosts that spell it differently pass `mcp` themselves. */
export function mcpOf(toolName: string): { readonly server: string; readonly tool: string } | undefined {
  const found = /^mcp__(.+?)__(.+)$/.exec(toolName);
  return found?.[1] === undefined || found[2] === undefined ? undefined : { server: found[1], tool: found[2] };
}

export type AckSubject = {
  readonly tool?: string;
  readonly mcp?: { readonly server: string; readonly account?: string; readonly tool?: string };
  readonly verdict?: FloorVerdict;
};

export type AckRequirement = {
  readonly labels: readonly string[];
  readonly why: readonly string[];
};

export function labelOf(match: AckMatch): string {
  if ("class" in match) return `class ${match.class}`;
  if ("command" in match) return `command ${match.command.join(" ")}`;
  if ("mcp" in match) {
    return `mcp ${[match.mcp, match.tool].filter((part) => part !== undefined).join("/")}`;
  }
  return `tool ${match.tool}`;
}

function matches(match: AckMatch, subject: AckSubject): boolean {
  if ("class" in match) return subject.verdict !== undefined && classesOf(subject.verdict).includes(match.class);
  if ("command" in match) {
    const units = subject.verdict?.seen ?? [];
    return units.some((unit) => {
      const identity = [unit.argv0, ...unit.spine, ...unit.familyArgs];
      return match.command.length <= identity.length && match.command.every((word, i) => identity[i] === word);
    });
  }
  const mcp = subject.mcp ?? (subject.tool === undefined ? undefined : mcpOf(subject.tool));
  if ("mcp" in match) {
    return (
      mcp !== undefined &&
      mcp.server === match.mcp &&
      (match.tool === undefined || mcp.tool === match.tool) &&
      (match.account === undefined || ("account" in mcp && mcp.account === match.account))
    );
  }
  return subject.tool === match.tool || (mcp !== undefined && mcp.tool === match.tool);
}

/** Null when no flag matches. */
export function acknowledgeRequirement(flags: readonly AckFlag[], subject: AckSubject): AckRequirement | null {
  const labels: string[] = [];
  const why: string[] = [];
  for (const flag of flags) {
    if (!matches(flag.match, subject)) continue;
    const label = labelOf(flag.match);
    if (!labels.includes(label)) labels.push(label);
    if (flag.why !== undefined && !why.includes(flag.why)) why.push(flag.why);
  }
  return labels.length === 0 ? null : { labels, why };
}

/** Strictest floor verdict for a call, with the host path preparation the adapters use. */
export function floorVerdictOf(
  call:
    | { readonly kind: "bash"; readonly command: string; readonly cwd?: string }
    | {
        readonly kind: "read" | "write";
        readonly path: string;
        readonly cwd?: string;
      },
): FloorVerdict {
  if (call.kind === "bash") return defaultPolicy.explainBash(call.command, undefined);
  const prepared = normalizeToolPath(call.path, call.cwd);
  const explain = call.kind === "read" ? defaultPolicy.explainRead : defaultPolicy.explainWrite;
  const first = explain(prepared);
  const second = explain(prepared.toLowerCase());
  const top = lattice([first.disposition, second.disposition]);
  return join([first, second].filter((verdict) => verdict.disposition === top));
}

export function blockReason(requirement: AckRequirement): string {
  return `needs acknowledgement: ${requirement.labels.join(", ")}`;
}

export type AckRequest = { readonly summary: string; readonly detail: string; readonly why?: string };
export type Acknowledger = (request: AckRequest) => Promise<boolean>;

const DETAIL_LIMIT = 500;

/** `text` is what the agent wrote (a command, a path, arguments). It is JSON-encoded and truncated. */
export function acknowledgeRequest(requirement: AckRequirement, tool: string, text: string): AckRequest {
  const encoded = JSON.stringify(text);
  const detail = encoded.length > DETAIL_LIMIT ? `${encoded.slice(0, DETAIL_LIMIT)}...` : encoded;
  const why = requirement.why.length === 0 ? undefined : requirement.why.join("; ");
  return {
    summary: `Acknowledge ${tool}: ${requirement.labels.join(", ")}`,
    detail,
    ...(why === undefined ? {} : { why }),
  };
}

/**
 * Ask the host. Undefined means acknowledged and the call may run; a string is the denial reason.
 * No `acknowledger` is the degraded path: the reason is `needs acknowledgement: <label>`.
 */
export async function requestAcknowledgement(
  requirement: AckRequirement,
  tool: string,
  text: string,
  acknowledger: Acknowledger | undefined,
): Promise<string | undefined> {
  if (acknowledger === undefined) return blockReason(requirement);
  try {
    const accepted = await acknowledger(acknowledgeRequest(requirement, tool, text));
    return accepted ? undefined : `acknowledgement declined: ${requirement.labels.join(", ")}`;
  } catch {
    return `acknowledgement failed: ${requirement.labels.join(", ")}`;
  }
}
