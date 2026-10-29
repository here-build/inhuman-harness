/**
 * The `authorization` block: how each soft-deny and ask is resolved, per mode, cluster and class.
 * One schema for every layer (dist, managed, user, project, session); each layer is a partial document.
 *
 * Tier names are "soft-deny" (engine `deny`) and "ask" (engine `ask`). `risky` / `general` do not exist.
 * The class taxonomy is closed: it is owned by `@inhuman.tools/policy` (classes.ts), and the list below
 * must equal it (a test in `@inhuman.tools/turn` pins that).
 */
import { z } from "zod";

export const CLASS_IDS = [
  "destroy-catastrophic",
  "destroy-local",
  "vcs-history",
  "privilege",
  "credential",
  "control-plane",
  "attack-shape",
  "policy-fault",
  "package-install",
  "publish",
  "remote-write",
  "network-egress",
  "exec-unknown",
  "unmodelled",
  "envelope-read",
  "envelope-write",
  "protected-file",
  "workspace-write",
  "mcp-lookup",
  "mcp-action",
] as const;
export type ClassId = (typeof CLASS_IDS)[number];

export const MODES = ["manual", "auto", "yolo"] as const;
export type AuthMode = (typeof MODES)[number];

export const CLUSTERS = ["bash", "read", "write", "mcp"] as const;
export type AuthCluster = (typeof CLUSTERS)[number];

/** Tiers a resolver is chosen for. Engine names. */
export type AuthTier = "deny" | "ask";

const classKey = z.enum(CLASS_IDS);
/** `shell` is `bash`. `ask` as a resolver word is `human` (the owner's wording). */
const resolverWord = z.enum(["allow", "judge", "human", "deny", "ask"]);

const judgeParams = z
  .object({
    /** Ask judge: allow needs `authorization + margin >= risk` (both 1..9). */
    margin: z.number().int().min(-8).max(8).optional(),
    /** Soft-deny judge: 1 = round 1 only, 2 = with the agent's last answer. */
    rounds: z.union([z.literal(1), z.literal(2)]).optional(),
    /** Soft-deny judge: the host checks the quoted user words. Only a user-layer cell may turn it off. */
    requireQuote: z.boolean().optional(),
  })
  .strict();
export type JudgeParams = z.infer<typeof judgeParams>;

const resolver = z.union([
  resolverWord,
  z
    .object({
      judge: judgeParams,
      onDeny: z.enum(["human", "deny", "ask"]).optional(),
      onFail: z.enum(["human", "deny", "ask"]).optional(),
    })
    .strict(),
]);
export type ResolverInput = z.infer<typeof resolver>;

/** One resolver for both tiers, or one per tier. */
const tierCell = z.object({ "soft-deny": resolver.optional(), ask: resolver.optional() }).strict();
const cell = z.union([resolver, tierCell]);
export type CellInput = z.infer<typeof cell>;

const clusterTable = z
  .object({
    "soft-deny": resolver.optional(),
    ask: resolver.optional(),
    classes: z.partialRecord(classKey, cell).optional(),
  })
  .strict();
export type ClusterTableInput = z.infer<typeof clusterTable>;

const modeTable = z
  .object({
    /** `auto` only: never ask a person, judge everything, fail closed. User layer only. */
    preset: z.literal("full").optional(),
    default: cell.optional(),
    classes: z.partialRecord(classKey, cell).optional(),
    bash: clusterTable.optional(),
    shell: clusterTable.optional(),
    read: clusterTable.optional(),
    write: clusterTable.optional(),
    mcp: clusterTable.optional(),
  })
  .strict();
export type ModeTableInput = z.infer<typeof modeTable>;

/** A user-added specific entry. Classes are closed; users add `{mcp, account?, tool}` and command families. */
const specificMatch = z.union([
  z
    .object({ mcp: z.string().min(1), account: z.string().min(1).optional(), tool: z.string().min(1).optional() })
    .strict(),
  z.object({ command: z.array(z.string().min(1)).min(1) }).strict(),
  z.object({ tool: z.string().min(1) }).strict(),
  z.object({ path: z.string().min(1), cluster: z.enum(["read", "write"]) }).strict(),
]);
export type SpecificMatch = z.infer<typeof specificMatch>;

/**
 * The tier a rule gives the floor for the calls it matches (MCP calls and named tools only): `allow` runs
 * without asking, `ask` is the host default, `soft-deny` needs the user's words and is never remembered,
 * `block` is never lifted. Loosening (below `ask`) is honoured in the user, session and managed layers; the
 * project layer and a managed `require` layer can only tighten.
 */
export const RULE_TIERS = ["allow", "ask", "soft-deny", "block"] as const;
export type RuleTier = (typeof RULE_TIERS)[number];

const specificRule = z
  .object({
    match: specificMatch,
    tier: z.enum(RULE_TIERS).optional(),
    /** What the call does, in the owner's words. Shown to the judge as trusted context, never as permission. */
    describe: z.string().min(1).max(500).optional(),
    resolve: z.object({ manual: cell, auto: cell, yolo: cell, unattended: cell }).partial().strict().optional(),
    /** Force an acknowledgement for this call even when it would run. Same as an `acknowledge` entry. */
    needsAcknowledgement: z.boolean().optional(),
    note: z.string().max(200).optional(),
  })
  .strict()
  .refine(
    (rule) =>
      (rule.tier === undefined && rule.describe === undefined) || !("command" in rule.match || "path" in rule.match),
    {
      message: "tier and describe apply to MCP and tool entries, not to command or path entries",
      path: ["tier"],
    },
  )
  .refine((rule) => rule.needsAcknowledgement !== true || !("path" in rule.match), {
    message:
      "needsAcknowledgement cannot be set on a path rule (acknowledgements match classes, MCP tools, tools and commands)",
    path: ["needsAcknowledgement"],
  });
export type SpecificRule = z.infer<typeof specificRule>;

/**
 * A flag that forces an acknowledgement (a human "yes, I know") before a call runs, even when the
 * verdict is allow. Not a tier: `block` stays block and a denial stays a denial.
 *
 * `class` matches the classes the floor voted (an approved call has none, so use `mcp`, `tool` or
 * `command` to flag one). `remove: true` (user, session and managed layers only) cancels an identical
 * flag from a weaker layer; a project file's removal is ignored (a project only tightens).
 */
const ackMatch = z.union([
  z.object({ class: classKey }).strict(),
  z
    .object({ mcp: z.string().min(1), account: z.string().min(1).optional(), tool: z.string().min(1).optional() })
    .strict(),
  z.object({ tool: z.string().min(1) }).strict(),
  z.object({ command: z.array(z.string().min(1)).min(1) }).strict(),
]);
export type AckMatch = z.infer<typeof ackMatch>;

const ackFlag = z
  .object({
    match: ackMatch,
    /** Shown on the prompt: "emails leave the company". */
    why: z.string().max(200).optional(),
    /** Modes in which the flag prompts. Absent: every mode, yolo and full-auto included. */
    modes: z.array(z.enum(MODES)).min(1).optional(),
    remove: z.boolean().optional(),
  })
  .strict();
export type AckFlagInput = z.infer<typeof ackFlag>;

const duration = z.union([z.null(), z.string().regex(/^\d+[smhd]$/)]);

export const authorizationConfigSchema = z
  .object({
    version: z.literal(2).optional(),
    manual: modeTable.optional(),
    auto: modeTable.optional(),
    yolo: modeTable.optional(),
    /** Overlay on the turn's mode table when the run is unattended. */
    unattended: modeTable.optional(),
    rules: z.array(specificRule).optional(),
    /** Calls that need an acknowledgement before they run (a flag, not a tier). A union across layers. */
    acknowledge: z.array(ackFlag).optional(),
    /** A bot uses the kernel default mode; the user may pin one per bot here. */
    botModes: z.record(z.string(), z.enum(MODES)).optional(),
    escalate: z
      .object({
        consecutiveDenials: z.number().int().min(1).optional(),
        totalDenials: z.number().int().min(1).optional(),
        window: z.number().int().min(1).optional(),
        /** Stop an unattended run after this many denials, judge or not. `null` turns it off. Default 60. */
        hardStopTotal: z.number().int().min(1).nullable().optional(),
        /** A bypass-check judge that fails twice stops the run (fail closed). `false` continues instead. */
        stopOnDoubleFail: z.boolean().optional(),
      })
      .strict()
      .optional(),
    grants: z
      .object({
        promptTtl: z
          .object({ session: duration, project: duration, bot: duration, global: duration })
          .partial()
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    judge: z
      .object({
        /** The unattended-run bypass check. On by default. */
        bypass: z.object({ enabled: z.boolean().optional() }).strict().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type AuthorizationConfig = z.infer<typeof authorizationConfigSchema>;

export type ParsedAuthorization =
  | { readonly ok: true; readonly config: AuthorizationConfig }
  | { readonly ok: false; readonly errors: readonly string[] };

/** Parse a layer from JSON text or an object. Empty text is the empty layer. */
export function parseAuthorizationConfig(input: unknown): ParsedAuthorization {
  let value = input;
  if (typeof input === "string") {
    if (input.trim() === "") return { ok: true, config: {} };
    try {
      value = JSON.parse(input);
    } catch (error) {
      return { ok: false, errors: [`not JSON: ${error instanceof Error ? error.message : String(error)}`] };
    }
  }
  if (value === undefined || value === null) return { ok: true, config: {} };
  const parsed = authorizationConfigSchema.safeParse(value);
  if (parsed.success) return { ok: true, config: parsed.data };
  return {
    ok: false,
    errors: parsed.error.issues.map((issue) => `${issue.path.join(".") || "authorization"}: ${issue.message}`),
  };
}
