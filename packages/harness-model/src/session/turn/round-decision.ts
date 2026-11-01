/** Model invocation is opt-in. Facts request a round; gates can prevent it. */
export type ContinuationKind =
  | "input"
  | "observation"
  | "call-repair"
  | "length-repair"
  | "thought-repair"
  | "auxiliary-repair"
  | "callback"
  | "intent"
  | "plugin"
  | "user"
  | "recovery";

export type ContinuationCause = {
  readonly kind: ContinuationKind;
  readonly sources: readonly string[];
};

export type ContinuationCandidate = {
  readonly cause: ContinuationCause;
  /** Attempts already admitted since progress, and the allowance in force. */
  readonly budget?: { readonly used: number; readonly limit: number };
};

export type TriggerAssessment = ContinuationCandidate & {
  readonly disposition: "eligible" | "exhausted";
};

export type IntentAssessment = {
  readonly verdict: "continue" | "question" | "seal" | null;
  readonly status: "judged" | "disabled" | "unconfigured" | "unsupported" | "failed" | "invalid";
  readonly detail: string;
};

export type RoundGate = {
  readonly reason:
    "provider-failed" | "content-filter" | "length-no-answer" | "round-limit" | "no-connection" | "plugin-refused";
  readonly detail: string;
};

export type RoundDecision = {
  readonly causes: readonly ContinuationCause[];
  readonly assessments: readonly TriggerAssessment[];
  readonly detail: string;
  readonly intent: IntentAssessment | null;
  readonly nextRoundId: string | null;
} & (
  | { readonly kind: "advance"; readonly reason: "triggered" }
  | { readonly kind: "halt"; readonly reason: "trigger-budget" | "awaiting-user" | "no-trigger" }
  | { readonly kind: "blocked"; readonly reason: RoundGate["reason"] }
);

const CAUSE_LABELS: Record<ContinuationKind, string> = {
  input: "new input",
  observation: "failed tool observations",
  "call-repair": "incomplete tool calls",
  "length-repair": "the output limit",
  "thought-repair": "reasoning without an answer",
  "auxiliary-repair": "auxiliary-only responses",
  callback: "an unanswered agent request",
  intent: "unfulfilled promised work",
  plugin: "plugin requests",
  user: "user requests",
  recovery: "recovery",
};

/** Pure, order-independent arbitration. A negative detector never vetoes another trigger. */
export function decideRound(
  candidates: readonly ContinuationCandidate[],
  gate: RoundGate | null = null,
  intent: IntentAssessment | null = null,
): RoundDecision {
  const assessments: TriggerAssessment[] = candidates.map((candidate) => ({
    ...candidate,
    disposition: candidate.budget != null && candidate.budget.used >= candidate.budget.limit ? "exhausted" : "eligible",
  }));
  const causes = assessments.filter((item) => item.disposition === "eligible").map((item) => item.cause);
  const exhausted = assessments.filter((item) => item.disposition === "exhausted");
  const common = { causes, assessments, intent, nextRoundId: null };
  if (gate != null) return { ...common, kind: "blocked", ...gate };
  if (causes.length > 0) return { ...common, kind: "advance", reason: "triggered", detail: "" };
  if (exhausted.length > 0) {
    return {
      ...common,
      kind: "halt",
      reason: "trigger-budget",
      detail: `Stopped: continuation budget exhausted for ${exhausted.map((item) => CAUSE_LABELS[item.cause.kind]).join(", ")}. Send another message to continue.`,
    };
  }
  return {
    ...common,
    kind: "halt",
    reason: intent?.verdict === "question" ? "awaiting-user" : "no-trigger",
    detail: intent?.detail ?? "",
  };
}
