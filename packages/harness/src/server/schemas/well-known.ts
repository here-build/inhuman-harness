import { z } from "zod";

import { unknownRecordSchema } from "./json-record.js";

export const connectionSliceSchema = z
  .object({
    driver: z.string().trim().min(1),
    name: z.string().default(""),
    annotation: z.string().default(""),
    secrets: z.unknown().optional(),
    settings: z.record(z.string(), z.unknown()).optional(),
    /** Catalog cut. Lifted into `settings.tools` so one bag owns spawn + hide. */
    tools: z.unknown().optional(),
    /** Severity overlay. Lifted into `settings.toolSeverity`. */
    toolSeverity: z.unknown().optional(),
    /** Durable Always-as-read names. Lifted into `settings.alwaysAllow`. */
    alwaysAllow: z.unknown().optional(),
  })
  .catchall(z.unknown())
  .transform(({ driver, name, annotation, secrets: _secrets, settings, tools, toolSeverity, alwaysAllow, ...rest }) => {
    const bag: Record<string, unknown> = { ...(settings ?? rest) };
    if (tools !== undefined) bag.tools = tools;
    if (toolSeverity !== undefined) bag.toolSeverity = toolSeverity;
    if (alwaysAllow !== undefined) bag.alwaysAllow = alwaysAllow;
    return { driver, name, annotation, settings: bag };
  });
const pluginPolicySchema = z.object({
  enabled: z.boolean().optional(),
  /** Content hashes of this plugin's guards a human approved. */
  guards: z.array(z.string().trim().min(1)).optional(),
  /** False keeps this plugin's `attach: foreground` bot off the foreground agent. */
  foreground: z.boolean().optional(),
});
const triggerLiteralSchema = z.union([z.string(), z.number().finite()]).transform(String);
export const compactTriggersSchema = z.object({
  hard: triggerLiteralSchema.optional(),
  soft: triggerLiteralSchema.optional(),
});
export const fileCatalogSchema = z.object({
  connections: z.record(z.string(), connectionSliceSchema).default({}),
  plugins: z.record(z.string(), pluginPolicySchema).default({}),
  compact: z.string().optional(),
  compactTriggers: compactTriggersSchema.optional(),
  /**
   * Minimum recent rounds preserved when compaction replaces older context.
   * Host clamps to >= 1 (0 puts the whole eat in the prefix, orphaning the in-flight
   * exchange). `compact.keep-turns` session kv and `context_need.preserve`
   * still raise this floor.
   */
  compactKeepTurns: z.number().int().nonnegative().optional(),
  /**
   * Tail retention for the model input (`@inhuman.tools/turn/context`
   * `contextRetentionSchema`). Kept opaque here: the reflector validates it
   * field by field and drops what is invalid.
   */
  contextRetention: z.record(z.string(), z.unknown()).optional(),
  contextGlowRemaining: triggerLiteralSchema.optional(),
  autoModeClassifier: z.string().optional(),
  /**
   * The user layer of the authorization table (policy v2). Validated where it is used
   * (harness-model `parseAuthorizationConfig`); a block that does not parse is reported, not applied.
   */
  authorization: z.record(z.string(), z.unknown()).optional(),
  reActLoopIntentDetectedTrigger: z
    .object({
      enabled: z.boolean().optional(),
      models: z.record(z.string(), z.boolean()).optional(),
    })
    .optional(),
  defaultPermissionMode: z.string().optional(),
  speculativePolicyProcessingTools: z.number().finite().optional(),
  approvalAskThrottleMs: z.number().finite().nonnegative().optional(),
  shellTailBytes: z.number().finite().nonnegative().optional(),
  /** Loop caps. Omitted or 0 is unlimited. See `KernelRoot.maxRounds`. */
  maxRounds: z.number().finite().nonnegative().optional(),
  maxDepth: z.number().finite().nonnegative().optional(),
  maxBotRounds: z.number().finite().nonnegative().optional(),
  maxBotDepth: z.number().finite().nonnegative().optional(),
  /** Rounds that continue an answer cut off by the output limit. Omitted is 3; 0 is off. */
  lengthContinuations: z.number().finite().nonnegative().optional(),
  /** Retry budget for transient model errors. Omitted or 0 is no limit. */
  retryMaxMs: z.number().finite().nonnegative().optional(),
  retryMaxAttempts: z.number().finite().nonnegative().optional(),
  superKey: z.string().optional(),
  /** Compact tape drops floor-allow calls. Omitted / false keeps them, including while open. */
  hideFloorTools: z.boolean().optional(),
  statusline: z.string().optional(),
  statuslineRefresh: z.string().optional(),
});
export type ConnectionSlice = z.output<typeof connectionSliceSchema>;
export type ConfigJson = z.output<typeof fileCatalogSchema>;

function keepParsedRecord<T>(raw: unknown, schema: z.ZodType<T>): Record<string, T> {
  const bag = unknownRecordSchema.safeParse(raw);
  if (!bag.success) return {};
  const out: Record<string, T> = {};
  for (const [key, value] of Object.entries(bag.data)) {
    const parsed = schema.safeParse(value);
    if (parsed.success) out[key] = parsed.data;
  }
  return out;
}

/** Disk catalog → full config. Invalid rows and fields are dropped, not fatal. */
export function parseConfigJson(raw: unknown): ConfigJson {
  const src = unknownRecordSchema.safeParse(raw);
  const bag = src.success ? src.data : {};
  const prepared: Record<string, unknown> = {
    ...bag,
    connections: keepParsedRecord(bag.connections, connectionSliceSchema),
    plugins: keepParsedRecord(bag.plugins, pluginPolicySchema),
  };
  const picked: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(fileCatalogSchema.shape)) {
    if (!(key in prepared)) continue;
    const parsed = schema.safeParse(prepared[key]);
    if (parsed.success) picked[key] = parsed.data;
  }
  return fileCatalogSchema.parse(picked);
}

const kvScalarSchema = z.union([
  z.string(),
  z.number().finite().transform(String),
  z.boolean().transform((value) => (value ? "true" : "false")),
]);
export const kvBagSchema = z.record(z.string(), kvScalarSchema);

/** Object JSON bag; skip non-scalar values the way mutate-kv used to. */
export function parseKvBag(raw: unknown): Record<string, string> {
  const record = unknownRecordSchema.safeParse(raw);
  if (!record.success) return {};
  const bag: Record<string, string> = {};
  for (const [key, value] of Object.entries(record.data)) {
    const parsed = kvScalarSchema.safeParse(value);
    if (parsed.success) bag[key] = parsed.data;
  }
  return bag;
}
