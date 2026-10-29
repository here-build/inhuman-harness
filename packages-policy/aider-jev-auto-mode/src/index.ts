import { jevDecideCapability } from "@inhuman.tools/env-capability-decision-jev";
import { judgeWith, type ProgramSource } from "@inhuman.tools/policy-aider";

export { evaluateCall, evaluateCallWithReason } from "@inhuman.tools/policy-aider";
export type { Call, EvaluateOptions, Outcome, Judge, JudgeDocument, ProgramSource, Verdict } from "@inhuman.tools/policy-aider";

export function jevJudge(apiKey: string, source?: ProgramSource) {
  return judgeWith(jevDecideCapability, { apiKey }, source);
}
