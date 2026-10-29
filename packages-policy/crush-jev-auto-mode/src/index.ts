import { jevDecideCapability } from "@inhuman.tools/env-capability-decision-jev";
import { judgeWith, type Judge } from "@inhuman.tools/policy-crush";
import { programSource } from "@inhuman.tools/policy-crush/hook";

function present(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

export function jevJudge(env: NodeJS.ProcessEnv): Judge {
  const key = present(env.TYPESAFE_API_KEY) ?? present(env.JEV_API_KEY);
  if (key === undefined) return (): "deny" => "deny";
  return judgeWith(jevDecideCapability, { apiKey: key }, programSource(env));
}
