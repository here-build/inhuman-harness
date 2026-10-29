import { sageDecideCapability } from "@inhuman.tools/env-capability-decision-sage";
import { judgeWith, type ProgramSource } from "@inhuman.tools/policy-aider";

export { evaluateCall, evaluateCallWithReason } from "@inhuman.tools/policy-aider";
export type { Call, EvaluateOptions, Outcome, Judge, JudgeDocument, ProgramSource, Verdict } from "@inhuman.tools/policy-aider";

export function sageJudge(apiKey: string, source?: ProgramSource) {
  return judgeWith(sageDecideCapability, { apiKey }, source);
}
