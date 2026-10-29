/**
 * Dist `policy.json` is the never-throwing program in policy-processor.
 * `{kernelFsRoot}/policy.json` wins when present and non-empty.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { reasonableDefaultsSource } from "@inhuman.tools/policy/floor";

export function distPolicySource(): string {
  return reasonableDefaultsSource;
}

function readOperatorPolicySource(kernelFsRoot: string): string | undefined {
  try {
    const user = readFileSync(join(kernelFsRoot, "policy.json"), "utf8");
    if (user.trim() !== "") return user;
  } catch {
    /* missing operator policy is dist */
  }
  return undefined;
}

/**
 * Body of the one policy program. Never throws. Missing operator → dist.
 */
export function loadPolicySource(kernelFsRoot: string): string | undefined {
  return readOperatorPolicySource(kernelFsRoot) ?? distPolicySource();
}
