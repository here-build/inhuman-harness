/**
 * `contextRetention` — JSON-configurable tail retention. Nothing here deletes
 * graph state: a rule decides what a projected item leaves behind once its
 * horizon has passed. Design: `tail-retention-design.md` §3–§4.
 */
import { z } from "zod";

export const RETENTION_KINDS = [
  "image.user",
  "image.tool",
  "tool.read",
  "tool.search",
  "tool.shell",
  "tool.write",
  "tool.args.write",
  "tool.web.search",
  "tool.web.fetch",
  "tool.mcp",
  "tool.program",
  "tool.agent",
  "tool.comm",
  "tool.other",
  "thinking",
  "steer",
  "approval-note",
  "notification",
  "system-note",
  "error",
] as const;
export type RetentionKind = (typeof RETENTION_KINDS)[number];

/** Authored by the user. Untrusted layers (project, agent, tool) cannot shorten these. */
export const USER_AUTHORED_KINDS: ReadonlySet<string> = new Set(["steer", "approval-note", "image.user"]);

/** Kinds whose item is a tool result row. `leave: "none"` is not allowed: every tool_call needs a tool row. */
export const NONE_FORBIDDEN_KINDS: ReadonlySet<string> = new Set([
  "tool.read",
  "tool.search",
  "tool.shell",
  "tool.write",
  "tool.web.search",
  "tool.web.fetch",
  "tool.mcp",
  "tool.program",
  "tool.agent",
  "tool.comm",
  "tool.other",
  "error",
]);

export const horizonSchema = z.union([
  z.enum(["round", "turn", "compaction", "forever"]),
  z.object({ rounds: z.number().int().min(1) }).strict(),
  z.object({ turns: z.number().int().min(1) }).strict(),
  z.object({ newest: z.number().int().min(0) }).strict(),
]);
export type Horizon = z.output<typeof horizonSchema>;

export const leaveSchema = z.union([
  z.enum(["none", "stub", "summary"]),
  z.object({ head: z.number().int().min(0).max(5000) }).strict(),
]);
export type Leave = z.output<typeof leaveSchema>;

const keepSchema = z.union([horizonSchema, z.array(horizonSchema).min(1)]);

export const ruleSchema = z.object({
  keep: keepSchema.optional(),
  leave: leaveSchema.optional(),
  /** Never elide below this many painted chars. */
  minChars: z.number().int().min(0).optional(),
  /** Error overlay for this rule. `null` disables it. */
  onError: z.object({ keep: keepSchema, leave: leaveSchema }).nullable().optional(),
});
export type RuleInput = z.output<typeof ruleSchema>;

export const stepSchema = z.object({
  turnBoundary: z.boolean().default(true),
  everyRounds: z.number().int().min(1).nullable().default(4),
  minFreedTokens: z.number().int().min(0).default(8000),
  whenCacheCold: z.boolean().default(true),
  atCompaction: z.literal(true).default(true),
});
export type StepConfig = z.output<typeof stepSchema>;

export const contextRetentionSchema = z.object({
  version: z.literal(1).default(1),
  defaults: z.object({ minChars: z.number().int().min(0).default(800) }).prefault({}),
  step: stepSchema.prefault({}),
  kinds: z.record(z.string(), ruleSchema).default({}),
  /** Keys: wire name ("shell"), "mcp:<server>/<tool>", globs ("mcp:github/*", "mcp:*"). */
  tools: z.record(z.string(), ruleSchema).default({}),
  /** Per-dialect thinking override, e.g. {"anthropic": {"keep": "forever"}}. */
  dialects: z.record(z.string(), ruleSchema).default({}),
});
export type ContextRetention = z.output<typeof contextRetentionSchema>;

/** A rule with every field concrete. This is what R2 stamps on a job. */
export type ConcreteRule = {
  readonly keep: readonly Horizon[];
  readonly leave: Leave;
  readonly minChars: number;
  readonly onError: { readonly keep: readonly Horizon[]; readonly leave: Leave } | null;
};

/** A partial policy as one source wrote it. */
export type RetentionLayer = {
  readonly defaults?: { readonly minChars?: number };
  readonly step?: Partial<StepConfig>;
  readonly kinds?: Readonly<Record<string, RuleInput>>;
  readonly tools?: Readonly<Record<string, RuleInput>>;
  readonly dialects?: Readonly<Record<string, RuleInput>>;
};

export function horizonList(keep: RuleInput["keep"]): Horizon[] {
  if (keep === undefined) return [];
  return Array.isArray(keep) ? [...keep] : [keep];
}

function jsonOf(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  if (raw.trim() === "") return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

const STEP_FIELDS: ReadonlyArray<readonly [keyof StepConfig, z.ZodType]> = [
  ["turnBoundary", z.boolean()],
  ["everyRounds", z.number().int().min(1).nullable()],
  ["minFreedTokens", z.number().int().min(0)],
  ["whenCacheCold", z.boolean()],
];

/**
 * Tolerant parse of a `contextRetention` block (an object or its JSON text).
 * An invalid field is dropped and never fatal, matching the rest of
 * `config.json`. Only fields the author wrote survive: defaults are the dist
 * layer's business, so the result is a partial layer.
 */
export function parseRetentionLayer(raw: unknown): RetentionLayer {
  const value = jsonOf(raw);
  if (value == null || typeof value !== "object" || Array.isArray(value)) return {};
  const rec = value as Record<string, unknown>;
  let layer: RetentionLayer = {};
  const defaults = z.object({ minChars: z.number().int().min(0).optional() }).safeParse(rec.defaults);
  if (defaults.success && defaults.data.minChars !== undefined) {
    layer = { ...layer, defaults: { minChars: defaults.data.minChars } };
  }
  if (rec.step != null && typeof rec.step === "object" && !Array.isArray(rec.step)) {
    const written = rec.step as Record<string, unknown>;
    const step: Partial<Record<keyof StepConfig, unknown>> = {};
    for (const [key, schema] of STEP_FIELDS) {
      const parsed = schema.safeParse(written[key]);
      if (parsed.success) step[key] = parsed.data;
    }
    if (Object.keys(step).length > 0) layer = { ...layer, step: step as Partial<StepConfig> };
  }
  for (const section of ["kinds", "tools", "dialects"] as const) {
    const bag = rec[section];
    if (bag == null || typeof bag !== "object" || Array.isArray(bag)) continue;
    const out: Record<string, RuleInput> = {};
    for (const [key, ruleRaw] of Object.entries(bag as Record<string, unknown>)) {
      if (section === "kinds" && !(RETENTION_KINDS as readonly string[]).includes(key)) continue;
      const parsed = ruleSchema.safeParse(ruleRaw);
      if (parsed.success) out[key] = parsed.data;
    }
    if (Object.keys(out).length > 0) layer = { ...layer, [section]: out };
  }
  return layer;
}
