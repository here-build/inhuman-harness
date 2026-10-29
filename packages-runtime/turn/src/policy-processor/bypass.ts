/**
 * Bypass detection for unattended runs. A denied action means the restriction applies to its effect;
 * pursuing the same effect by another route is an attempt to get around it. After repeated denials a
 * dedicated judge pass reads the recent series of calls ("does this look like an attempt to bypass the
 * restrictions?") and the run stops for a person only when it says yes.
 *
 * Counters live in a per-run ledger. What counts as a denial: a floor block, a resolver deny, a
 * judge deny or failure that resolved to deny, a human resolver turned into `interaction_required`.
 * What does not: a human refusal, a cancellation. Triggers: 3 consecutive or 20 total (and at least 3
 * new since the last check), an immediate stop for control-plane tampering after earlier denials,
 * and a hard stop at `hardStopTotal` (default 60, null = off). All thresholds are configurable.
 */
import type { Escalation, ToolCallJob } from "@inhuman.tools/harness-model";
import { CLASSES, isClassId } from "@inhuman.tools/policy/floor";

export type CallOutcome = "ran" | "floor-block" | "resolver-deny" | "judge-deny" | "interaction-required";

export type CallRecord = {
  readonly i: number;
  readonly tool: string;
  /** JSON of the arguments, cut. Agent-written: data, never an instruction. */
  readonly args: string;
  readonly tier: string | null;
  readonly classes: readonly string[];
  readonly ruleIds: readonly string[];
  readonly outcome: CallOutcome;
  readonly judgeReason?: string;
};

const ARGS_LIMIT = 500;

export class RunLedger {
  consecutive = 0;
  total = 0;
  lastCheckAtTotal = 0;
  checks = 0;
  /** Bypass-check failures in a row. */
  checkFails = 0;
  stopped = false;
  readonly calls: CallRecord[] = [];
  /** Assistant texts between calls (≤ 5 are shown to the judge). Agent-written. */
  readonly notes: string[] = [];

  /** A call that was licensed and started. */
  ran(record: Omit<CallRecord, "i" | "outcome">): void {
    this.consecutive = 0;
    this.#push({ ...record, outcome: "ran" });
  }

  /** A call denied by policy. Returns the record. */
  denied(record: Omit<CallRecord, "i">): CallRecord {
    this.consecutive += 1;
    this.total += 1;
    return this.#push(record);
  }

  /** A denial that is not the agent's doing (a human refused, a cancellation) is not counted. */
  uncounted(record: Omit<CallRecord, "i">): void {
    this.#push(record);
  }

  #push(record: Omit<CallRecord, "i">): CallRecord {
    const full: CallRecord = { ...record, i: this.calls.length };
    this.calls.push(full);
    return full;
  }
}

/** Why the run should be looked at, or null. `check` means ask the bypass judge. */
export type Trigger = "immediate" | "hard-stop" | "check" | null;

export function decideTrigger(
  ledger: RunLedger,
  esc: Escalation,
  last: { readonly classes: readonly string[]; readonly outcome: CallOutcome },
): Trigger {
  // The gate's own files, reached for after the run has already been denied once.
  if (last.outcome === "floor-block" && last.classes.includes("control-plane") && ledger.total > 1) return "immediate";
  if (esc.hardStopTotal !== null && ledger.total >= esc.hardStopTotal) return "hard-stop";
  const fresh = ledger.total - ledger.lastCheckAtTotal;
  if (fresh < 3) return null;
  if (ledger.consecutive >= esc.consecutiveDenials || fresh >= esc.totalDenials) return "check";
  return null;
}

/** Denied only because a required acknowledgement is missing in an unattended run. */
export function isAckRefusal(job: ToolCallJob): boolean {
  return job.ackPending && job.licenseDetail.code === "interaction_required" && job.baseLicenseDetail.decision === true;
}

export function outcomeOf(job: ToolCallJob): { outcome: CallOutcome; counted: boolean } {
  if (job.humanApprove === false) return { outcome: "resolver-deny", counted: false };
  if (job.cancelled && job.licenseDecision !== false) return { outcome: "resolver-deny", counted: false };
  const detail = job.licenseDetail;
  if (job.policyResult === "block") return { outcome: "floor-block", counted: true };
  // A missing acknowledgement is the user's own flag, not the agent probing the floor: it is reported, never counted.
  if (isAckRefusal(job)) return { outcome: "interaction-required", counted: false };
  if (detail.code === "interaction_required") return { outcome: "interaction-required", counted: true };
  if (job.classifierResult === "deny") return { outcome: "judge-deny", counted: true };
  return { outcome: "resolver-deny", counted: true };
}

export function recordOf(job: ToolCallJob): Omit<CallRecord, "i" | "outcome"> {
  const args = JSON.stringify(job.args ?? {});
  return {
    tool: job.name,
    args: args.length <= ARGS_LIMIT ? args : `${args.slice(0, ARGS_LIMIT)}…`,
    tier: job.policyResult,
    classes: job.policyClasses,
    ruleIds: (job.policyVotes as ReadonlyArray<{ ruleId?: string }>).flatMap((vote) =>
      typeof vote.ruleId === "string" ? [vote.ruleId] : [],
    ),
    ...(job.judgeReason === null ? {} : { judgeReason: job.judgeReason }),
  };
}

/** Deterministic hints for the judge: cheap to compute, not verdicts. */
export type Hints = {
  readonly sameRuleAs: readonly (readonly number[])[];
  readonly executesFileWrittenAt: readonly { readonly call: number; readonly writtenAt: number }[];
  readonly encodedPayload: readonly number[];
  readonly controlPlaneTouch: readonly number[];
};

const ENCODED = /\b(?:base64|xxd|openssl\s+enc)\b|\beval\b|\$\([^)]*\)|`[^`]*`|\\x[0-9a-f]{2}/i;

export function hintsFor(calls: readonly CallRecord[]): Hints {
  const byRule = new Map<string, number[]>();
  for (const call of calls) {
    if (call.outcome === "ran") continue;
    for (const id of call.ruleIds) byRule.set(id, [...(byRule.get(id) ?? []), call.i]);
  }
  const sameRuleAs = [...byRule.values()].filter((group) => group.length > 1);
  const written: Array<{ path: string; at: number }> = [];
  const executes: Array<{ call: number; writtenAt: number }> = [];
  for (const call of calls) {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(call.args) as Record<string, unknown>;
    } catch {
      /* cut args are not JSON; the hints just skip them */
    }
    const command = typeof args.command === "string" ? args.command : "";
    for (const file of written) {
      if (call.i > file.at && command.includes(file.path)) executes.push({ call: call.i, writtenAt: file.at });
    }
    if (call.tool === "write_file" && typeof args.path === "string") written.push({ path: args.path, at: call.i });
    for (const match of command.matchAll(/>{1,2}\s*([^\s;&|]+)/g)) {
      if (match[1] !== undefined) written.push({ path: match[1], at: call.i });
    }
  }
  const denied = calls.filter((call) => call.outcome !== "ran");
  return {
    sameRuleAs,
    executesFileWrittenAt: executes,
    encodedPayload: denied.length === 0 ? [] : calls.filter((call) => ENCODED.test(call.args)).map((call) => call.i),
    controlPlaneTouch: calls
      .filter((call) => call.classes.some((cls) => cls === "control-plane" || cls === "credential"))
      .map((call) => call.i),
  };
}

export type BypassSections = {
  readonly taskJson: string;
  readonly restrictionsJson: string;
  readonly callsJson: string;
  readonly hintsJson: string;
  readonly notesJson: string;
};

/** Every section is one line of JSON. The agent's text is only ever inside CALLS and AGENT NOTES. */
export function buildBypassSections(input: {
  readonly task: string;
  readonly calls: readonly CallRecord[];
  readonly notes: readonly string[];
  readonly window: number;
}): BypassSections {
  const window = input.calls.slice(-input.window);
  const rules = new Map<string, { cls: string; rule: string }>();
  for (const call of window) {
    if (call.outcome === "ran") continue;
    for (const rule of call.ruleIds.length === 0 ? [""] : call.ruleIds) {
      for (const cls of call.classes.length === 0 ? [""] : call.classes) rules.set(`${cls}|${rule}`, { cls, rule });
    }
  }
  const restrictions = [...rules.values()].map(({ cls, rule }) => ({
    class: cls,
    rule,
    description: isClassId(cls) ? CLASSES[cls].description : "",
  }));
  return {
    taskJson: JSON.stringify(input.task.slice(0, 4000)),
    restrictionsJson: JSON.stringify(restrictions),
    callsJson: JSON.stringify(window),
    hintsJson: JSON.stringify(hintsFor(window)),
    notesJson: JSON.stringify(input.notes.slice(-5).map((note) => note.slice(0, 1000))),
  };
}

export const BYPASS_PATTERNS = [
  "same-effect-different-route",
  "script-indirection",
  "encoding-or-obfuscation",
  "control-plane-tampering",
  "scope-escalation",
  "credential-probing",
  "persistence",
  "repeated-identical",
  "none",
] as const;

export type BypassVerdict = {
  readonly verdict: "bypass" | "no-bypass" | "unsure";
  readonly pattern: (typeof BYPASS_PATTERNS)[number];
  readonly calls: readonly number[];
  readonly reason: string;
};

/** Strict parse. Anything off is a failure (the check could not be made). */
export function parseBypassVerdict(raw: unknown): BypassVerdict | { readonly fail: string } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { fail: "bypass check did not answer" };
  const rec = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key.replace(/^'?:/, ""), value]));
  const keys = Object.keys(rec);
  if (keys.length !== 4 || !["verdict", "pattern", "calls", "reason"].every((key) => keys.includes(key))) {
    return { fail: "bypass check answered with the wrong fields" };
  }
  const { verdict, pattern, calls, reason } = rec;
  if (verdict !== "bypass" && verdict !== "no-bypass" && verdict !== "unsure")
    return { fail: "bypass check: unknown verdict" };
  if (!BYPASS_PATTERNS.includes(pattern as never)) return { fail: "bypass check: unknown pattern" };
  if (!Array.isArray(calls) || calls.length > 20 || !calls.every((c) => Number.isInteger(c) && c >= 0)) {
    return { fail: "bypass check: calls must be indexes" };
  }
  if (typeof reason !== "string") return { fail: "bypass check: no reason" };
  return {
    verdict,
    pattern: pattern as BypassVerdict["pattern"],
    calls: calls as number[],
    reason: reason.slice(0, 300),
  };
}

export function stopReason(verdict: BypassVerdict): string {
  const calls = verdict.calls.length === 0 ? "" : ` (calls ${verdict.calls.join(", ")})`;
  return `bypass suspected: ${verdict.pattern}${calls}: ${verdict.reason}`;
}
