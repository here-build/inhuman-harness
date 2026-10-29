import { botMcpGrantSchema } from "@inhuman.tools/harness-contract";
import { REASONING_EFFORTS } from "@inhuman.tools/plugin-sdk";
import { z } from "zod";

const nonempty = z.string().trim().min(1);

const jsonDataSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonDataSchema),
    z.record(z.string(), jsonDataSchema),
  ]),
);

export const behaviorBindingSchema = z.strictObject({
  plugin: nonempty,
  scope: z.enum(["session", "project", "global"]),
  methods: z.array(nonempty).min(1),
});

/** Bot-selected behavior. Program is required when the block is present. */
export const behaviorSelectionSchema = z.strictObject({
  program: nonempty,
  environment: nonempty.optional(),
  configuration: z.record(z.string(), jsonDataSchema).optional(),
  bindings: z.record(nonempty, behaviorBindingSchema).optional(),
});

function adoptRecipeScopeKey(value: unknown): unknown {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return value;
  const rec = { ...(value as Record<string, unknown>) };
  if (rec.recipeScope === undefined && "scope" in rec) rec.recipeScope = rec.scope;
  delete rec.scope;
  return rec;
}

export const botDefinitionSchema = z.preprocess(
  adoptRecipeScopeKey,
  z.strictObject({
    name: z
      .string()
      .trim()
      .min(1, "invalid name")
      .refine((value) => !value.includes("__"), { message: "invalid name" })
      .optional(),
    recipeScope: z
      .enum(["invocation", "session", "workspace", "global"])
      .default("session")
      .transform((scope): "session" | "project" | "global" =>
        scope === "workspace" ? "project" : scope === "global" ? "global" : "session",
      ),
    instructions: z.string().trim().default(""),
    description: z.string().trim().default(""),
    tools: z.array(nonempty).default([]),
    keepAlive: z.boolean().default(false),
    invokes: z.array(nonempty).default([]),
    reasoningEffort: z.enum(REASONING_EFFORTS).optional(),
    modelPreferences: z.array(nonempty).default([]),
    skills: z.array(nonempty).default([]),
    behavior: behaviorSelectionSchema.optional(),
    /**
     * Named access to an existing server. The server name is required.
     * An omitted tool list is every tool of that server. `account` and
     * `session` narrow which connection of that name. This does not spawn.
     */
    mcp: z.array(botMcpGrantSchema).default([]),
    mcpServers: z.never({ error: "forbidden key mcpServers" }).optional(),
    permissionMode: z.never({ error: "forbidden key permissionMode" }).optional(),
    hooks: z.never({ error: "forbidden key hooks" }).optional(),
    isolation: z.never({ error: "forbidden key isolation" }).optional(),
    memory: z.never({ error: "forbidden key memory" }).optional(),
    "allowed-tools": z.never({ error: "forbidden key allowed-tools" }).optional(),
    allowedTools: z.never({ error: "forbidden key allowedTools" }).optional(),
  }),
);

/** Defined in the contract package; re-exported so existing imports keep working. */
export { type BotMcpGrant, botMcpGrantSchema } from "@inhuman.tools/harness-contract";
