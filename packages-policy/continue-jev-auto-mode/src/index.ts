import { jevDecideCapability } from "@inhuman.tools/env-capability-decision-jev";
import { judgeWith, type ProgramSource } from "@inhuman.tools/policy-continue";

export { evaluateCall, evaluateCallWithReason } from "@inhuman.tools/policy-continue";
export type { Call, EvaluateOptions, Outcome, Judge, JudgeDocument, ProgramSource, Verdict } from "@inhuman.tools/policy-continue";

export function jevJudge(apiKey: string, source?: ProgramSource) {
  return judgeWith(jevDecideCapability, { apiKey }, source);
}
