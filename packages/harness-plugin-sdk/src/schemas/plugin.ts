/**
 * Zod shapes for plugin-sdk constructors. Tools, actions, envCapabilities,
 * bots, mcpServers. plugin.json extension format is the daemon's, not this
 * package's.
 */
import type { EnvCapability } from "@here.build/arrival";
import { asSystemPrompt } from "@inhuman.tools/harness-commons";
import { z } from "zod";

export const inhumanBrand = {
  tool: Symbol.for("@inhuman.tools/InhumanTool"),
  action: Symbol.for("@inhuman.tools/InhumanAction"),
  plugin: Symbol.for("@inhuman.tools/InhumanPlugin"),
} as const;

const zodType = z.custom<z.ZodType>(
  (value) => value != null && typeof (value as { parse?: unknown }).parse === "function",
  { message: "zod schema required" },
);

const fn = z.custom<(...args: never[]) => unknown>((value) => typeof value === "function", {
  message: "JS function required",
});

/** `tool` is completions tools[]. `symbol` is a scheme_repl name. `both` is both. */
export const toolRepresentation = z.enum(["tool", "symbol", "both"]);
export type ToolRepresentation = z.infer<typeof toolRepresentation>;

const tapeFace = z.string().trim().min(1, "tape face must be a non-empty string").nullable().default(null);

const toolBase = {
  name: z.string().trim().min(1, "InhumanTool: non-empty name required"),
  description: z.string().optional(),
  class: z.string().optional(),
  /** Omitted function tools are symbols. Omitted bot-calls are tools. */
  representation: toolRepresentation.optional(),
  input: zodType,
  output: zodType,
  triggersReactLoop: z.boolean().optional(),
  isSideChannel: z.boolean().optional(),
  tapeHidden: z.boolean().optional(),
  question: tapeFace,
  effect: tapeFace,
  caption: tapeFace,
  exam: z
    .object({
      program: fn,
      admit: fn,
      settle: fn.optional(),
      prefixAsk: fn.optional(),
      finish: fn.optional(),
    })
    .optional(),
};

export const functionToolDef = z
  .object({
    ...toolBase,
    type: z.literal("function").optional(),
    run: fn.optional(),
  })
  .superRefine((row, ctx) => {
    if (row.exam == null && row.run == null) {
      ctx.addIssue({ code: "custom", message: "function requires run" });
    }
  });

function catalogShow(raw: string | undefined): "result" | "omit" | "turn" {
  if (raw === "silent" || raw === "omit") return "omit";
  if (raw === "turn") return "turn";
  return "result";
}

function catalogLifetime(raw: string | undefined): "turn" | "call" {
  if (raw === "call") return "call";
  return "turn";
}

export const botCallToolDef = z
  .object({
    ...toolBase,
    type: z.literal("bot-call"),
    target: z.string().trim().min(1, "bot-call target required"),
    prepare: fn.optional(),
    background: z.boolean().optional(),
    lifetime: z.enum(["turn", "call"]).optional(),
    show: z.enum(["result", "omit", "turn", "silent"]).optional(),
    delivery: z.enum(["result", "silent", "turn"]).optional(),
    deadlineMs: z.number().optional(),
    maxResultTokens: z.number().optional(),
    supportsNotify: z.boolean().optional(),
  })
  .superRefine((row, ctx) => {
    const raw = row.show ?? row.delivery;
    if (raw === "turn" && (row.background !== true || !(row.deadlineMs != null && row.deadlineMs > 0))) {
      ctx.addIssue({ code: "custom", message: "show turn requires background and positive deadlineMs" });
    }
  })
  .transform((row) => {
    const { delivery: _delivery, show: rawShow, lifetime: rawLifetime, ...rest } = row;
    return {
      ...rest,
      show: catalogShow(rawShow ?? _delivery),
      lifetime: catalogLifetime(rawLifetime),
    };
  });

export const toolDef = z.union([functionToolDef, botCallToolDef]);

export const normalizedActionDef = z.object({
  name: z.string().trim().min(1, "InhumanAction: non-empty name required"),
  description: z.string().optional(),
  seat: z.enum(["session", "harness"]).default("session"),
  input: zodType.optional(),
  run: fn,
});

export const actionDef = normalizedActionDef;

const brandedTool = z.custom<{ readonly name: string }>(
  (value) =>
    typeof value === "object" && value !== null && (value as { [k: symbol]: unknown })[inhumanBrand.tool] === true,
  { message: "must be InhumanTool" },
);

const plainTool = z.union([functionToolDef, botCallToolDef]);

const brandedAction = z.custom<{ readonly name: string }>(
  (value) =>
    typeof value === "object" && value !== null && (value as { [k: symbol]: unknown })[inhumanBrand.action] === true,
  { message: "must be InhumanAction" },
);

const plainAction = normalizedActionDef;

export const envCapability = z.custom<EnvCapability>(
  (value) =>
    typeof value === "object" &&
    value !== null &&
    typeof (value as { name?: unknown }).name === "string" &&
    typeof (value as { exports?: unknown }).exports === "function",
  { message: "must be Arrival EnvCapability" },
);

export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

const nonempty = z.string().trim().min(1);

export const botMcpBindingDef = z
  .object({
    server: nonempty,
    tools: z.array(nonempty).default([]),
    approval: z.enum(["allow", "policy"]).optional(),
  })
  .transform((row) => ({
    server: row.server,
    tools: row.tools,
    approval: row.approval === "allow" ? ("allow" as const) : ("policy" as const),
  }));

export const botDef = z.preprocess(
  (value) => {
    if (value == null || typeof value !== "object" || Array.isArray(value)) return value;
    const rec = { ...(value as Record<string, unknown>) };
    if (rec.recipeScope === undefined && "scope" in rec) rec.recipeScope = rec.scope;
    delete rec.scope;
    return rec;
  },
  z
    .object({
      name: nonempty,
      recipeScope: z.enum(["invocation", "session", "workspace", "global"]),
      instructions: nonempty,
      description: z.string().trim().optional(),
      tools: z.array(nonempty).default([]),
      mcp: z.array(botMcpBindingDef).default([]),
      keepAlive: z.boolean().optional(),
      invokes: z.array(nonempty).default([]),
      reasoningEffort: z.enum(REASONING_EFFORTS).optional(),
      modelPreferences: z.array(nonempty).default([]),
      skills: z.array(nonempty).default([]),
    })
    .transform((row) => ({
      name: row.name,
      recipeScope: row.recipeScope,
      instructions: asSystemPrompt(row.instructions),
      ...(row.description === undefined || row.description === "" ? {} : { description: row.description }),
      tools: row.tools,
      mcp: row.mcp,
      keepAlive: row.keepAlive === true,
      invokes: row.invokes,
      ...(row.reasoningEffort === undefined ? {} : { reasoningEffort: row.reasoningEffort }),
      modelPreferences: row.modelPreferences,
      skills: row.skills,
    })),
);

export const mcpServerDef = z.object({
  name: nonempty,
  visibility: z.enum(["private", "public"]),
  scope: z.enum(["session", "workspace", "global"]),
  transport: z.object({
    type: z.literal("stdio"),
    command: nonempty,
    args: z.array(z.string()).default([]),
    cwd: z.enum(["plugin", "workspace"]),
    env: z
      .union([
        z.record(z.string(), z.string()),
        z.custom<(ctx: { readonly pluginRoot: string; readonly workspaceRoot: string }) => Record<string, string>>(
          (value) => typeof value === "function",
          { message: "JS function required" },
        ),
      ])
      .optional(),
  }),
});

export const pluginProjectionDef = z.object({
  initial: z.custom<() => unknown>((value) => typeof value === "function", { message: "JS function required" }),
  reduce: z.custom<(state: unknown, action: unknown) => unknown>((value) => typeof value === "function", {
    message: "JS function required",
  }),
  hostOnly: z
    .custom<(action: unknown) => boolean>((value) => typeof value === "function", { message: "JS function required" })
    .optional(),
});

export const exclusiveSlotsDef = z.array(nonempty);

export const pluginDef = z
  .object({
    apiVersion: z.literal(1).optional(),
    tools: z.array(z.union([brandedTool, plainTool])).default([]),
    actions: z.array(z.union([brandedAction, plainAction])).default([]),
    envCapabilities: z.array(envCapability).default([]),
    bots: z.array(botDef).default([]),
    mcpServers: z.array(mcpServerDef).default([]),
    exclusiveSlots: exclusiveSlotsDef.default([]),
    projection: pluginProjectionDef.optional(),
  })
  .superRefine((bag, ctx) => {
    const seen = new Set<string>();
    for (const [index, action] of bag.actions.entries()) {
      const name =
        typeof action === "object" && action !== null && "name" in action
          ? String((action as { name?: unknown }).name ?? "")
          : "";
      if (seen.has(name)) {
        ctx.addIssue({
          code: "custom",
          message: `action "${name}" collides`,
          path: ["actions", index],
        });
      }
      seen.add(name);
    }
  });

export const toolContext = z
  .object({
    root: z.string().optional(),
    signal: z.custom<AbortSignal>((value) => value instanceof AbortSignal).optional(),
    turn: z.unknown().optional(),
    completion: z.unknown().nullable().optional(),
    invocation: z.unknown().optional(),
    storage: z
      .object({
        session: z.unknown(),
        invocation: z.unknown(),
        project: z.unknown().optional(),
        global: z.unknown().optional(),
        propose: fn,
      })
      .optional(),
  })
  .passthrough();

export type NormalizedActionDefinition = z.infer<typeof normalizedActionDef>;

export const inhumanShape = {
  toolDef,
  functionToolDef,
  botCallToolDef,
  actionDef,
  normalizedActionDef,
  pluginDef,
  botDef,
  botMcpBindingDef,
  mcpServerDef,
  pluginProjectionDef,
  exclusiveSlotsDef,
  toolContext,
  envCapability,
} as const;
