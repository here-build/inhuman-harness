/**
 * Unattended coded receipts. Residual ask under auto is the judge, not
 * `policy_denied`. Operator throw is awareness + dist, not `policy_error`.
 */
import { isEvalPermissionMode, type EvalFailureCode, type EvalPermissionMode } from "@inhuman.tools/harness-model";

export function resolveEvalPermissionMode(policy: string): EvalPermissionMode | null {
  return isEvalPermissionMode(policy) ? policy : null;
}

export function unattendedFailureText(code: EvalFailureCode, policyId: string, reason?: string): string {
  switch (code) {
    case "interaction_required":
      return `Operation requires human authorization under policy ${policyId}`;
    case "policy_denied":
      return `Operation denied under policy ${policyId}`;
    case "policy_error":
      return reason != null && reason !== ""
        ? `Policy evaluation failed under policy ${policyId}: ${reason}`
        : `Policy evaluation failed under policy ${policyId}`;
    case "policy_unavailable":
      return `Policy ${policyId} is not available`;
  }
}
