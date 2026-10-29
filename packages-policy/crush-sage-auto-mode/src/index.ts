import { sageDecideCapability } from "@inhuman.tools/env-capability-decision-sage";
import { judgeWith, type Judge } from "@inhuman.tools/policy-crush";
import { programSource } from "@inhuman.tools/policy-crush/hook";

export function sageJudge(env: NodeJS.ProcessEnv): Judge {
  const trimmed = env.SAGE_API_KEY?.trim();
  const key = trimmed === undefined || trimmed === "" ? undefined : trimmed;
  if (key === undefined) return (): "deny" => "deny";
  return judgeWith(sageDecideCapability, { apiKey: key }, programSource(env));
}
