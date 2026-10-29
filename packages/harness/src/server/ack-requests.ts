/**
 * Pending acknowledgements, as `ack/pending` reports them. A call that is allowed (or would be, once
 * its ask is answered) but carries a `needsAcknowledgement` flag waits for a person. There is no ack
 * job and no transcript entry: the daemon reads the `ackState` stamp on the call and renders it here.
 */
import {
  type ApprovableJob,
  type ClassId,
  DEFAULT_PROMPT_TTL,
  type GrantScope,
  parseTtl,
  type SessionRoot,
  ToolCallJob,
} from "@inhuman.tools/harness-model";

const DETAIL_MAX = 1200;
const SUMMARY_MAX = 160;

export type AckRequest = {
  readonly ackId: string;
  readonly sessionId: string;
  readonly jobId: string;
  readonly tool: string;
  readonly summary: string;
  readonly detail: string;
  readonly flags: Array<{ label: string; why?: string; layer: "dist" | "managed" | "user" | "project" | "session" }>;
  readonly verdict: {
    tier: "allow" | "ask" | "soft-deny";
    classes: ClassId[];
    licensedBy: "floor" | "grant" | "judge" | "resolver" | "pending";
  };
  readonly storeOptions: Array<{
    scope: GrantScope;
    subject: ApprovableJob["ackOptions"][number]["subject"];
    label: string;
    defaultTtlMs: number | null;
  }>;
  readonly createdAtMs: number;
};

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Agent-written strings are JSON-encoded, so a prompt cannot be forged by what the model wrote. */
function renderArgs(job: ApprovableJob): string {
  const args = job instanceof ToolCallJob ? job.args : null;
  if (args == null) return "";
  try {
    return clip(JSON.stringify(args), DETAIL_MAX);
  } catch {
    return "";
  }
}

function summaryOf(job: ApprovableJob): string {
  if (!(job instanceof ToolCallJob)) return job.constructor.name;
  const command = job.args?.command;
  if (job.name === "shell" && typeof command === "string") return clip(`shell · ${JSON.stringify(command)}`, SUMMARY_MAX);
  const mcp = job.grantMcp;
  if (mcp !== undefined) return clip(`${mcp.server} · ${mcp.tool}`, SUMMARY_MAX);
  return clip(job.name, SUMMARY_MAX);
}

function licensedBy(job: ApprovableJob): AckRequest["verdict"]["licensedBy"] {
  if (job.baseLicenseDetail.decision !== true) return "pending";
  if (job.policyResult === "policyApprove") return "floor";
  if (job.grantCovers) return "grant";
  if (job.classifierResult === "allow") return "judge";
  return "resolver";
}

/** Scopes a prompt may store an acknowledgement in. `bot` only when the session is a bot. */
export function ackStoreScopes(bot: string | undefined): GrantScope[] {
  return bot === undefined ? ["session", "project", "global"] : ["session", "project", "bot", "global"];
}

export function ackRequestOf(
  root: SessionRoot,
  job: ApprovableJob,
  env: { readonly bot?: string; readonly promptTtl?: Partial<Record<GrantScope, string | null>>; readonly now: number },
): AckRequest {
  const tier =
    job.policyResult === "ask" ? "ask" : job.policyResult === "deny" ? "soft-deny" : ("allow" as const);
  return {
    ackId: job.uuid,
    sessionId: root.sessionId,
    jobId: job.uuid,
    tool: job instanceof ToolCallJob ? job.name : job.constructor.name,
    summary: summaryOf(job),
    detail: renderArgs(job),
    flags: job.ackFlags.map((flag) => ({
      label: flag.label,
      ...(flag.why === undefined ? {} : { why: flag.why }),
      layer: flag.layer,
    })),
    verdict: { tier, classes: [...job.policyClasses], licensedBy: licensedBy(job) },
    storeOptions: job.ackOptions.flatMap((option) =>
      ackStoreScopes(env.bot).map((scope) => ({
        scope,
        subject: option.subject,
        label: option.label,
        defaultTtlMs: parseTtl(env.promptTtl?.[scope] ?? DEFAULT_PROMPT_TTL[scope]),
      })),
    ),
    createdAtMs: env.now,
  };
}
