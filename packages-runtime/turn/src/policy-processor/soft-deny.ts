/**
 * Soft-deny judge, host half. The question is "did the user explicitly request this exact action?".
 * The model never gets the last word: the host builds every prompt section (one line of JSON each, so
 * agent text cannot forge a label), parses the vote strictly, and verifies the quoted user words
 * itself. Any parse error, missing sink or failed quote check is a `fail` (the cell's `onFail`),
 * never an allow. Untrusted content (tool output, the agent's own text) is never authorization.
 */
import { CLASSES, type ClassId, type FloorVote } from "@inhuman.tools/policy/floor";

/** Authorization the model must claim before a soft-deny allow counts (on top of >= risk). */
export const SOFT_DENY_MIN_AUTHORIZATION = 7;
/** A quote shorter than this proves nothing. */
export const MIN_QUOTE_CHARS = 3;
/** Strings in the proposed call are cut at this length in the prompt (the verification is not). */
const CALL_STRING_LIMIT = 2000;
const MESSAGE_LIMIT = 8000;

export type SoftDenyOutcome =
  | { readonly kind: "vote"; readonly decision: "allow" | "deny"; readonly round: 1 | 2; readonly reason: string }
  /** Round 1 asks for the agent's last answer. */
  | { readonly kind: "need-agent-answer"; readonly reason: string }
  | { readonly kind: "fail"; readonly reason: string };

export type SoftDenyCheck = {
  /** Oldest first. The only source of permission. */
  readonly userMessages: readonly string[];
  /** The agent's last answer before the latest user message, or "" when there is none. */
  readonly agentAnswer: string;
  /** Words that must appear in the quote for the action to be the one asked for. */
  readonly identityTokens: readonly string[];
  /** Verify the quote and the identity of the action. Only a user-layer cell may turn this off. */
  readonly requireQuote: boolean;
  /** Allow needs `authorization + margin >= risk`. */
  readonly margin: number;
};

/** NFC, case folded, whitespace collapsed: the form both sides of a quote check are compared in. */
export function normalizeQuote(text: string): string {
  return text.normalize("NFC").toLowerCase().replaceAll(/\s+/g, " ").trim();
}

function contains(haystack: string, needle: string): boolean {
  const want = normalizeQuote(needle);
  return want.length >= MIN_QUOTE_CHARS && normalizeQuote(haystack).includes(want);
}

function words(text: string): Set<string> {
  return new Set(
    normalizeQuote(text)
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word !== ""),
  );
}

/** Does `text` name the action: any identity token is a word of it (or a substring for path-like tokens)? */
export function namesAction(text: string, tokens: readonly string[]): boolean {
  if (tokens.length === 0) return true;
  const folded = normalizeQuote(text);
  const set = words(text);
  return tokens.some((token) => {
    const want = normalizeQuote(token);
    return want !== "" && (set.has(want) || (/[./_-]/.test(want) && folded.includes(want)));
  });
}

const KEYS_R1 = new Set(["verdict", "quote", "reason", "risk", "authorization"]);
const KEYS_R2 = new Set([...KEYS_R1, "proposal"]);

function clean(raw: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(raw).map(([key, value]) => [key.replace(/^'?:/, ""), value]));
}

const isScore = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 9;

/**
 * Parse and verify one round's vote. `raw` is what the program returned. Strict: unknown or missing
 * keys, a wrong type or enum are `fail`. Quote and identity checks are the host's, not the model's.
 */
export function parseSoftDenyVote(raw: unknown, round: 1 | 2, check: SoftDenyCheck): SoftDenyOutcome {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { kind: "fail", reason: "soft-deny judge did not vote" };
  }
  const vote = clean(raw as Record<string, unknown>);
  const allowed = round === 1 ? KEYS_R1 : KEYS_R2;
  for (const key of Object.keys(vote)) {
    if (!allowed.has(key)) return { kind: "fail", reason: `soft-deny vote has an unexpected field ${key}` };
  }
  const { verdict, quote, reason, risk, authorization } = vote;
  const proposal = vote.proposal;
  if (typeof reason !== "string" || typeof quote !== "string") {
    return { kind: "fail", reason: "soft-deny vote is missing quote or reason" };
  }
  if (!isScore(risk) || !isScore(authorization))
    return { kind: "fail", reason: "soft-deny vote has no risk or authorization" };
  if (round === 2 && typeof proposal !== "string")
    return { kind: "fail", reason: "soft-deny round 2 vote has no proposal" };
  const why = reason.slice(0, 300);
  if (verdict === "deny") return { kind: "vote", decision: "deny", round, reason: why };
  const messages = check.userMessages;
  const latest = messages.at(-1) ?? "";
  if (verdict === "need-agent-answer") {
    if (round === 2) return { kind: "fail", reason: "soft-deny round 2 cannot ask for the agent's answer" };
    if (check.requireQuote && !contains(latest, quote)) return quoteFailure("confirmation");
    return { kind: "need-agent-answer", reason: why };
  }
  if (verdict !== "allow") return { kind: "fail", reason: "soft-deny vote has an unknown verdict" };
  if (check.requireQuote) {
    if (round === 1) {
      if (!messages.some((message) => contains(message, quote))) return quoteFailure("request");
      if (!namesAction(quote, check.identityTokens)) {
        // The user's words are real but do not name this action: at most a confirmation of something else.
        return { kind: "need-agent-answer", reason: "the quoted words do not name the action" };
      }
    } else {
      if (!contains(latest, quote)) return quoteFailure("confirmation");
      if (check.agentAnswer === "" || !contains(check.agentAnswer, proposal as string)) return quoteFailure("proposal");
      if (!namesAction(proposal as string, check.identityTokens)) {
        return { kind: "fail", reason: "the proposal does not name the action" };
      }
    }
  }
  if (authorization < SOFT_DENY_MIN_AUTHORIZATION || authorization + check.margin < risk) {
    return {
      kind: "vote",
      decision: "deny",
      round,
      reason: `authorization ${authorization} does not cover risk ${risk}: ${why}`,
    };
  }
  return { kind: "vote", decision: "allow", round, reason: why };
}

/** A quote that is not in the user's words is a red-team signal, and a failure, not a deny. */
function quoteFailure(what: string): SoftDenyOutcome {
  return { kind: "fail", reason: `judge.quote_unverified: the ${what} quoted by the judge is not in the transcript` };
}

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…[${text.length - limit} more characters]`;
}

function clipValue(value: unknown): unknown {
  if (typeof value === "string") return clip(value, CALL_STRING_LIMIT);
  if (Array.isArray(value)) return value.map((item) => clipValue(item));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clipValue(item)]));
  }
  return value;
}

export type SoftDenySections = {
  readonly floorJson: string;
  readonly userJson: string;
  readonly callJson: string;
  readonly agentAnswerJson: string;
};

/** Every section is `JSON.stringify` output: one line, so nothing inside can start a new labelled section. */
export function buildSoftDenySections(input: {
  readonly classes: readonly ClassId[];
  readonly votes: readonly Pick<FloorVote, "ruleId">[];
  readonly userMessages: readonly string[];
  readonly agentAnswer: string;
  readonly allowAgentAnswer: boolean;
  readonly tool: string;
  readonly cluster: string;
  readonly args: unknown;
  /** The policy owner's words about this call (a rule's `describe`). Trusted context for the judge, not permission. */
  readonly describe?: string;
}): SoftDenySections {
  return {
    floorJson: JSON.stringify({
      tier: "soft-deny",
      classes: input.classes.map((id) => ({ id, label: CLASSES[id].label, description: CLASSES[id].description })),
      rules: input.votes.map((vote) => vote.ruleId),
      ...(input.describe === undefined || input.describe === ""
        ? {}
        : { ownerDescription: clip(input.describe, MESSAGE_LIMIT) }),
    }),
    userJson: JSON.stringify(input.userMessages.map((message) => clip(message, MESSAGE_LIMIT))),
    callJson: JSON.stringify({ tool: input.tool, cluster: input.cluster, args: clipValue(input.args ?? {}) }),
    agentAnswerJson:
      input.allowAgentAnswer && input.agentAnswer !== "" ? JSON.stringify(clip(input.agentAnswer, MESSAGE_LIMIT)) : "",
  };
}

/** Words the user's quote must contain for the action to be the one they asked for. */
export function identityTokens(input: {
  readonly cluster: string;
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>> | null;
  readonly votes: readonly FloorVote[];
  readonly serverToolName?: string;
}): string[] {
  const out = new Set<string>();
  const base = (path: string) => path.split("/").filter(Boolean).at(-1) ?? path;
  switch (input.cluster) {
    case "bash": {
      for (const vote of input.votes) {
        if (vote.unit === undefined) continue;
        out.add(base(vote.unit.argv0));
        for (const word of vote.unit.spine) out.add(word);
        for (const word of vote.unit.familyArgs) out.add(word);
      }
      if (out.size === 0 && typeof input.args?.command === "string") {
        const first = input.args.command.trim().split(/\s+/)[0];
        if (first !== undefined && first !== "") out.add(base(first));
      }
      break;
    }
    case "read":
    case "write": {
      const path = input.args?.path ?? input.args?.cwd;
      if (typeof path === "string" && path !== "") out.add(base(path));
      for (const vote of input.votes) if (vote.path !== undefined) out.add(base(vote.path.path));
      break;
    }
    default: {
      const name = input.serverToolName ?? input.tool;
      for (const word of name.split(/[_\-./\s]+|(?<=[a-z0-9])(?=[A-Z])/).filter(Boolean)) out.add(word);
    }
  }
  return [...out];
}
