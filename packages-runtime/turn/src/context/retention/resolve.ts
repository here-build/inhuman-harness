/**
 * Layering (design §4.4) and per-item rule resolution.
 *
 *   dist → managed → user        trusted: may loosen, replace per key
 *   project, session, agent      narrowing only, and project/agent never touch
 *                                user-authored kinds
 *   tool self-declaration        narrowing only, its own tool key only (at admit)
 *
 * Session kv is narrowing-only by owner decision: the interpreter can reach
 * `kv/set`, so a model must not be able to lengthen what it later reads.
 */
import { createHash } from "node:crypto";

import { DEFAULT_CONTEXT_RETENTION, LEGACY_CONTEXT_RETENTION } from "./defaults.js";
import { canonicalKeep, keepRank, narrowKeep, narrowRule, narrows } from "./narrow.js";
import {
  contextRetentionSchema,
  horizonList,
  horizonSchema,
  NONE_FORBIDDEN_KINDS,
  parseRetentionLayer,
  RETENTION_KINDS,
  USER_AUTHORED_KINDS,
  type ConcreteRule,
  type ContextRetention,
  type Horizon,
  type RetentionLayer,
  type RuleInput,
} from "./schema.js";

export type NarrowSource = "project" | "session" | "agent" | "tool";

/** A resolved policy: the layered config plus the narrowing overlays that name tools. */
export type ResolvedPolicy = ContextRetention & {
  /** Narrowing overlays keyed like `tools`; applied on top of the matched rule at admit. */
  readonly narrowTools: Readonly<Record<string, RuleInput>>;
  /** First 12 hex of the policy digest. Diagnostic only. */
  readonly hash: string;
};

export type ResolveInput = {
  /** Trusted layers: a partial layer or the raw `contextRetention` block (object or JSON text). */
  readonly managed?: unknown;
  readonly user?: unknown;
  /** Narrowing layers. */
  readonly project?: unknown;
  readonly session?: RetentionLayer;
  readonly agent?: unknown;
};

export type ResolveResult = { readonly policy: ResolvedPolicy; readonly ignored: readonly string[] };

function mergeRuleBag(
  base: Readonly<Record<string, RuleInput>>,
  layer: Readonly<Record<string, RuleInput>> | undefined,
): Record<string, RuleInput> {
  const out: Record<string, RuleInput> = { ...base };
  for (const [key, rule] of Object.entries(layer ?? {})) out[key] = { ...out[key], ...rule };
  return out;
}

function applyTrusted(base: ContextRetention, layer: RetentionLayer): ContextRetention {
  return {
    ...base,
    defaults: { ...base.defaults, ...layer.defaults },
    step: { ...base.step, ...layer.step },
    kinds: mergeRuleBag(base.kinds, layer.kinds),
    tools: mergeRuleBag(base.tools, layer.tools),
    dialects: mergeRuleBag(base.dialects, layer.dialects),
  };
}

function digest(policy: Omit<ResolvedPolicy, "hash">): string {
  return createHash("sha256").update(JSON.stringify(policy)).digest("hex").slice(0, 12);
}

function seal(policy: Omit<ResolvedPolicy, "hash">): ResolvedPolicy {
  return { ...policy, hash: digest(policy) };
}

function applyNarrowing(
  policy: Omit<ResolvedPolicy, "hash">,
  layer: RetentionLayer,
  source: NarrowSource,
  ignored: string[],
): Omit<ResolvedPolicy, "hash"> {
  let kinds: Record<string, RuleInput> = { ...policy.kinds };
  const narrowTools: Record<string, RuleInput> = { ...policy.narrowTools };
  let defaults = policy.defaults;
  if (layer.step !== undefined) ignored.push(`${source}: step is not narrowable`);
  if (layer.dialects !== undefined) ignored.push(`${source}: dialects are not narrowable`);
  if (layer.defaults?.minChars !== undefined) {
    defaults = { minChars: Math.min(defaults.minChars, layer.defaults.minChars) };
  }
  for (const [kind, rule] of Object.entries(layer.kinds ?? {})) {
    if (source !== "session" && USER_AUTHORED_KINDS.has(kind)) {
      ignored.push(`${source}: kind ${kind} is user-authored`);
      continue;
    }
    const base = kinds[kind] ?? {};
    if (!narrows(base, rule, kind)) {
      ignored.push(`${source}: kinds.${kind} does not shorten retention`);
      continue;
    }
    kinds = { ...kinds, [kind]: narrowRule(base, rule, kind) };
  }
  for (const [key, rule] of Object.entries(layer.tools ?? {})) {
    narrowTools[key] = narrowRule(narrowTools[key] ?? {}, rule, null);
  }
  return { ...policy, defaults, kinds, narrowTools };
}

export function resolveRetention(input: ResolveInput = {}): ResolveResult {
  const ignored: string[] = [];
  let base: ContextRetention = DEFAULT_CONTEXT_RETENTION;
  if (input.managed !== undefined) base = applyTrusted(base, parseRetentionLayer(input.managed));
  if (input.user !== undefined) base = applyTrusted(base, parseRetentionLayer(input.user));
  let policy: Omit<ResolvedPolicy, "hash"> = { ...base, narrowTools: {} };
  if (input.project !== undefined) {
    policy = applyNarrowing(policy, parseRetentionLayer(input.project), "project", ignored);
  }
  if (input.session !== undefined) policy = applyNarrowing(policy, input.session, "session", ignored);
  if (input.agent !== undefined) policy = applyNarrowing(policy, parseRetentionLayer(input.agent), "agent", ignored);
  return { policy: seal(policy), ignored };
}

/** The pre-retention rule set: everything lives until compaction (plus the owner's picture and note rules). */
export const LEGACY_POLICY: ResolvedPolicy = seal({ ...LEGACY_CONTEXT_RETENTION, narrowTools: {} });

function sessionHorizon(raw: string): Horizon[] | null {
  const text = raw.trim();
  if (text === "") return null;
  let value: unknown = text;
  try {
    value = JSON.parse(text);
  } catch {
    value = text;
  }
  const list = Array.isArray(value) ? value : [value];
  const out: Horizon[] = [];
  for (const entry of list) {
    const parsed = horizonSchema.safeParse(entry);
    if (!parsed.success) return null;
    out.push(parsed.data);
  }
  return out.length === 0 ? null : out;
}

/**
 * Session kv → a narrowing layer. `retention.<kind>` and
 * `retention.tool.<key>` hold a JSON horizon (`"round"`, `{"rounds":2}`, or an array).
 */
export function sessionRetentionLayer(kvs: Readonly<Record<string, string>>): RetentionLayer {
  const kinds: Record<string, RuleInput> = {};
  const tools: Record<string, RuleInput> = {};
  for (const [key, raw] of Object.entries(kvs)) {
    if (!key.startsWith("retention.")) continue;
    const keep = sessionHorizon(raw);
    if (keep === null) continue;
    const rest = key.slice("retention.".length);
    // A kind name wins (`retention.tool.read` is the kind); anything else under `tool.` is a tool key.
    if ((RETENTION_KINDS as readonly string[]).includes(rest)) {
      kinds[rest] = { keep };
      continue;
    }
    if (rest.startsWith("tool.")) {
      const toolKey = rest.slice("tool.".length);
      if (toolKey !== "") tools[toolKey] = { keep };
    }
  }
  return {
    ...(Object.keys(kinds).length === 0 ? {} : { kinds }),
    ...(Object.keys(tools).length === 0 ? {} : { tools }),
  };
}

// --- stamp text -----------------------------------------------------------------------------

const policyCache = new Map<string, ResolvedPolicy | null>();

export function serializePolicy(policy: ResolvedPolicy): string {
  return JSON.stringify(policy);
}

/** Parse an R1 stamp. Empty or malformed is `null` (the caller inherits or falls back to legacy). */
export function parsePolicy(json: string): ResolvedPolicy | null {
  if (json === "") return null;
  const hit = policyCache.get(json);
  if (hit !== undefined) return hit;
  let out: ResolvedPolicy | null = null;
  try {
    const raw = JSON.parse(json) as Record<string, unknown>;
    const parsed = contextRetentionSchema.safeParse(raw);
    if (parsed.success) {
      const narrow = raw.narrowTools;
      out = {
        ...parsed.data,
        narrowTools:
          narrow != null && typeof narrow === "object" ? parseRetentionLayer({ tools: narrow }).tools ?? {} : {},
        hash: typeof raw.hash === "string" ? raw.hash : "",
      };
    }
  } catch {
    out = null;
  }
  if (policyCache.size > 64) policyCache.clear();
  policyCache.set(json, out);
  return out;
}

// --- per-item rule --------------------------------------------------------------------------

function globToRegExp(glob: string): RegExp {
  return new RegExp(`^${glob.split("*").map((part) => part.replaceAll(/[$()*+.?[\\\]^{|}]/g, String.raw`\$&`)).join(".*")}$`);
}

function lookup<T>(bag: Readonly<Record<string, T>>, names: readonly string[]): T | undefined {
  for (const name of names) {
    if (name !== "" && Object.hasOwn(bag, name)) return bag[name];
  }
  let best: { readonly glob: string; readonly value: T } | undefined;
  for (const [glob, value] of Object.entries(bag)) {
    if (!glob.includes("*")) continue;
    const re = globToRegExp(glob);
    if (names.some((name) => name !== "" && re.test(name)) && (best === undefined || glob.length > best.glob.length)) {
      best = { glob, value };
    }
  }
  return best?.value;
}

function ruleKeep(rule: RuleInput | undefined, fallback: readonly Horizon[]): readonly Horizon[] {
  const keep = horizonList(rule?.keep);
  return keep.length === 0 ? fallback : keep;
}

export type RuleQuery = {
  readonly kind: string;
  /** Names to match `tools`, most specific first: `mcp:server/tool`, then the wire name. */
  readonly names: readonly string[];
  /** The tool's own narrowing hint (catalog `retention`). Applies to its own key only. */
  readonly hint?: RuleInput;
};

/** The concrete rule for one item of `kind`. Pure over `policy`. */
export function ruleFor(policy: ResolvedPolicy, query: RuleQuery): ConcreteRule {
  const kindRule = policy.kinds[query.kind];
  const toolRule = lookup(policy.tools, query.names);
  let merged: RuleInput = { ...kindRule, ...toolRule };
  const overlay = lookup(policy.narrowTools, query.names);
  if (overlay !== undefined) merged = narrowRule(merged, overlay, query.kind);
  if (query.hint !== undefined) merged = narrowRule(merged, query.hint, query.kind);
  const errorRule = policy.kinds.error;
  const onErrorRaw =
    merged.onError === undefined
      ? errorRule?.keep === undefined || errorRule.leave === undefined
        ? null
        : { keep: errorRule.keep, leave: errorRule.leave }
      : merged.onError;
  let leave = merged.leave ?? "stub";
  if (leave === "none" && NONE_FORBIDDEN_KINDS.has(query.kind)) leave = "stub";
  return {
    keep: canonicalKeep(ruleKeep(merged, ["compaction"])),
    leave,
    minChars: merged.minChars ?? policy.defaults.minChars,
    onError:
      onErrorRaw === null
        ? null
        : {
            keep: canonicalKeep(horizonList(onErrorRaw.keep)),
            leave: onErrorRaw.leave === "none" ? "stub" : onErrorRaw.leave,
          },
  };
}

/** The rule of a non-tool item, judged by the policy of its own turn. */
export function kindRule(policy: ResolvedPolicy, kind: string, dialect?: string): ConcreteRule {
  const rule = ruleFor(policy, { kind, names: [] });
  if (kind !== "thinking" || dialect === undefined) return rule;
  const override = Object.hasOwn(policy.dialects, dialect) ? policy.dialects[dialect] : undefined;
  if (override === undefined) return rule;
  return {
    ...rule,
    keep: canonicalKeep(ruleKeep(override, rule.keep)),
    leave: override.leave ?? rule.leave,
  };
}

/**
 * A failed item outlives its kind: the longer of the kind's horizon and the
 * error overlay's wins, and the remainder is the overlay's when it won.
 */
export function effectiveRule(rule: ConcreteRule, failed: boolean): Pick<ConcreteRule, "keep" | "leave" | "minChars"> {
  if (!failed || rule.onError === null) return rule;
  if (keepRank(rule.onError.keep) > keepRank(rule.keep)) {
    return { keep: rule.onError.keep, leave: rule.onError.leave, minChars: 0 };
  }
  return rule;
}

export { narrowKeep };
