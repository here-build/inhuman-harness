/**
 * Classifier request cuts from the job's owning turn. Nested jobs keep
 * that turn; a caller-supplied turn would be the wrong one. Privileged
 * is user prompts on the owning turn and its tail ancestry — continue
 * mints `prompt: ""` with the authorization on the tail. Unattended /
 * eval with no user text: owning ProgrammaticJob expr (approval.md
 * EVIDENCE). The bag itself is not a remainder subject — only inner
 * ToolCallJob leaves.
 */
import {
  clusterOf,
  fileQuestion,
  ProgrammaticJob,
  reactChunks,
  SessionTurn,
  tapeCompletion,
  ToolCallJob,
} from "@inhuman.tools/harness-model";
import { parseTirithEvidence, tirithPolicyCut } from "@inhuman.tools/policy-tirith";

export type EvidenceCuts = {
  /** Oldest-first user prompts on the owning turn and its tails (the eval expression when there are none). */
  readonly userMessages?: readonly string[];
  /** The agent's last completed answer before the most recent user message. Round 2 of the soft-deny judge only. */
  readonly agentAnswer?: string;
  readonly privileged: string;
  readonly priorTurn: string;
  readonly quarantined: string;
  readonly policy?: string;
};

export function evidenceCuts(job: ToolCallJob): EvidenceCuts {
  const turn = owningTurn(job);
  const program = owningProgram(job);
  if (turn == null) {
    const expr = program?.expr.trim() || "";
    return {
      userMessages: expr === "" ? [] : [expr],
      agentAnswer: "",
      privileged: expr,
      priorTurn: "",
      quarantined: "",
      policy: policyPipCut(job.policyEvidenceJson),
    };
  }
  const prior: string[] = [];
  const quarantined: string[] = [];
  for (const chunk of reactChunks(turn)) {
    const completion = tapeCompletion(chunk);
    if (completion != null) {
      if (!completion.isDone || underJob(completion, job)) continue;
      if (completion.responseText !== "") prior.push(completion.responseText);
      continue;
    }
    if (!(chunk instanceof ToolCallJob) || chunk === job) continue;
    if (chunk.sealedOutcomeJson() == null) continue;
    const text = observationText(chunk.observationPayload());
    if (text === "") continue;
    quarantined.push(`${chunk.name} → ${text}`);
  }
  const messages = userPrompts(turn, program);
  return {
    userMessages: messages,
    agentAnswer: agentAnswerBefore(turn),
    privileged: messages.join("\n"),
    priorTurn: prior.join("\n"),
    quarantined: quarantined.join("\n"),
    policy: policyPipCut(job.policyEvidenceJson),
  };
}

function policyPipCut(json: string | null): string {
  if (json == null || json === "") return "";
  const report = parseTirithEvidence(json);
  if (report != null) return tirithPolicyCut(report);
  return json;
}

/** Oldest-first user prompts on `turn` then tails. Expr only when none exist. */
function userPrompts(turn: SessionTurn, program: ProgrammaticJob | null): string[] {
  const seen = new Set<SessionTurn>();
  const prompts: string[] = [];
  let cell: SessionTurn | null = turn;
  while (cell != null && !seen.has(cell)) {
    seen.add(cell);
    const text = cell.prompt.trim();
    if (text !== "") prompts.push(text);
    cell = cell.turnTail instanceof SessionTurn ? cell.turnTail : null;
  }
  prompts.reverse();
  if (prompts.length > 0) return prompts;
  const expr = program?.expr.trim() || "";
  return expr === "" ? [] : [expr];
}

/**
 * The agent's last completed answer that precedes the most recent user message: the proposal a short
 * reply ("let's do it") refers to. Not the current turn's text, never tool output. Empty when there is
 * none (the most recent user message opens the conversation).
 */
function agentAnswerBefore(turn: SessionTurn): string {
  const seen = new Set<SessionTurn>();
  let cell: SessionTurn | null = turn;
  while (cell != null && !seen.has(cell) && cell.prompt.trim() === "") {
    seen.add(cell);
    cell = cell.turnTail instanceof SessionTurn ? cell.turnTail : null;
  }
  // `cell` carries the most recent user prompt. Its tails hold the answers that came before it.
  let earlier: SessionTurn | null = cell != null && cell.turnTail instanceof SessionTurn ? cell.turnTail : null;
  while (earlier != null && !seen.has(earlier)) {
    seen.add(earlier);
    const chunks = reactChunks(earlier);
    for (const chunk of chunks.toReversed()) {
      const completion = tapeCompletion(chunk);
      if (completion != null && completion.isDone && completion.responseText !== "") return completion.responseText;
    }
    earlier = earlier.turnTail instanceof SessionTurn ? earlier.turnTail : null;
  }
  return "";
}

export function evidenceIdentity(cuts: EvidenceCuts): string {
  return JSON.stringify([cuts.privileged, cuts.priorTurn, cuts.quarantined, cuts.policy ?? "", cuts.agentAnswer ?? ""]);
}

/** Cluster+payload remainder skip key. */
export function evidencePayloadKey(job: ToolCallJob): string | null {
  const payload = canonicalPayload(job);
  if (payload == null || payload === "") return null;
  // The tier and classes are part of the key: a payload that was an ask under one policy and a
  // soft-deny under another must not share a vote.
  return JSON.stringify([clusterOf(job.name), payload, job.policyResult, job.policyClassesJson ?? ""]);
}

export function owningTurn(job: ToolCallJob): SessionTurn | null {
  return ancestor(job, (parent): parent is SessionTurn => parent instanceof SessionTurn);
}

function owningProgram(job: ToolCallJob): ProgrammaticJob | null {
  return ancestor(job, (parent): parent is ProgrammaticJob => parent instanceof ProgrammaticJob);
}

function ancestor<T>(job: { parent: unknown }, match: (parent: unknown) => parent is T): T | null {
  const seen = new Set<object>();
  let node: { parent: unknown } | null = job;
  while (node != null) {
    if (seen.has(node)) return null;
    seen.add(node);
    const parent: unknown = node.parent;
    if (match(parent)) return parent;
    if (parent instanceof SessionTurn) return null;
    node = parent !== null && typeof parent === "object" && "parent" in parent ? (parent as { parent: unknown }) : null;
  }
  return null;
}

function underJob(node: { parent: unknown }, job: ToolCallJob): boolean {
  const seen = new Set<object>();
  let cur: { parent: unknown } | null = node;
  while (cur != null) {
    if (seen.has(cur)) return false;
    seen.add(cur);
    if (cur === job) return true;
    const parent: unknown = cur.parent;
    if (parent instanceof SessionTurn) return false;
    cur = parent !== null && typeof parent === "object" && "parent" in parent ? (parent as { parent: unknown }) : null;
  }
  return false;
}

function observationText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try {
    const json = JSON.stringify(value);
    return typeof json === "string" ? json : "";
  } catch {
    return String(value);
  }
}

function canonicalPayload(job: ToolCallJob): string | null {
  const args = job.args;
  switch (clusterOf(job.name)) {
    case "bash": {
      const command = args?.command;
      if (typeof command !== "string" || command === "") return null;
      const cwd = args?.cwd;
      if (typeof cwd === "string" && cwd !== "" && cwd !== ".") return `${command}\ncwd ${cwd}`;
      return command;
    }
    case "read":
      return fileQuestion(job.name, args) ?? ".";
    case "write":
      return fileQuestion(job.name, args);
    case "mcp":
      return `${job.name}\n${stableJson(args ?? {})}`;
  }
}

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => sortKeys(item));
  const rec = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(rec)
      .toSorted()
      .map((key) => [key, sortKeys(rec[key])]),
  );
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}
