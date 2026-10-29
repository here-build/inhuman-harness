/**
 * The floor tier and judge description a specific rule (`{mcp, account?, tool}` or `{tool}`) gives a call.
 * Pure. Layering follows the resolution table:
 *
 *   tier     = first of managed.set > session > user that has a matching rule with a tier
 *              (absent: the host default, `ask`), then raised by project and managed.require, never lowered
 *   describe = first of managed.set > session > user that has a matching rule with one;
 *              a project file's words never reach the judge, because a repository is not the owner
 *
 * Several matching rules in one layer: the strictest tier, the first description.
 */
import type { AuthorizationConfig, RuleTier } from "./config.js";
import { type CallSubject, type Layers, matches } from "./resolve.js";

export type RuleStamp = { readonly tier?: RuleTier; readonly describe?: string };

const RANK: Readonly<Record<RuleTier, number>> = { allow: 0, ask: 1, "soft-deny": 2, block: 3 };
const HOST_DEFAULT: RuleTier = "ask";

function inLayer(cfg: AuthorizationConfig | undefined, subject: CallSubject): RuleStamp {
  let tier: RuleTier | undefined;
  let describe: string | undefined;
  for (const rule of cfg?.rules ?? []) {
    if (rule.tier === undefined && rule.describe === undefined) continue;
    if (!matches(rule.match, subject)) continue;
    if (rule.tier !== undefined && (tier === undefined || RANK[rule.tier] > RANK[tier])) tier = rule.tier;
    describe ??= rule.describe;
  }
  return { ...(tier === undefined ? {} : { tier }), ...(describe === undefined ? {} : { describe }) };
}

export function ruleStampFor(layers: Layers, subject: CallSubject | undefined): RuleStamp {
  if (subject === undefined) return {};
  let tier: RuleTier | undefined;
  let describe: string | undefined;
  for (const cfg of [layers.managedSet, layers.session, layers.user]) {
    const here = inLayer(cfg, subject);
    tier ??= here.tier;
    describe ??= here.describe;
  }
  for (const cfg of [layers.managedRequire, layers.project]) {
    const here = inLayer(cfg, subject).tier;
    if (here !== undefined && RANK[here] > RANK[tier ?? HOST_DEFAULT]) tier = here;
  }
  return { ...(tier === undefined ? {} : { tier }), ...(describe === undefined ? {} : { describe }) };
}
