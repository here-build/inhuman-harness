export { DEFAULT_CONTEXT_RETENTION, LEGACY_CONTEXT_RETENTION } from "./defaults.js";
export { canonicalKeep, narrowRule } from "./narrow.js";
export {
  effectiveRule,
  kindRule,
  LEGACY_POLICY,
  parsePolicy,
  resolveRetention,
  ruleFor,
  serializePolicy,
  sessionRetentionLayer,
  type ResolvedPolicy,
  type ResolveInput,
  type ResolveResult,
} from "./resolve.js";
export { REF_CHARS, jobRef, visualRef } from "./render.js";
export {
  contextRetentionSchema,
  parseRetentionLayer,
  RETENTION_KINDS,
  type ConcreteRule,
  type ContextRetention,
  type Horizon,
  type Leave,
  type RetentionKind,
  type RetentionLayer,
  type RuleInput,
} from "./schema.js";
export { decideRetentionStep, stampRetentionClock, type StepFacts } from "./step.js";
export { kindOfJob, parseJobStamp, stampJobRetention, type JobStamp } from "./stamp.js";
export { buildView, parseClock, policyOfTurn, type RetentionClock, type RetentionView } from "./view.js";

import { resolveRetention, serializePolicy, sessionRetentionLayer } from "./resolve.js";

/**
 * R1: the policy JSON a turn is stamped with at mint. `userConfigJson` is
 * `KernelRoot.contextRetentionJson`; session kv may only narrow it.
 */
export function turnRetentionJson(userConfigJson: string, kvs: Readonly<Record<string, string>>): string {
  const { policy } = resolveRetention({
    ...(userConfigJson === "" ? {} : { user: userConfigJson }),
    session: sessionRetentionLayer(kvs),
  });
  return serializePolicy(policy);
}
