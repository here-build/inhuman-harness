import { z } from "zod";

export const advertisedDriverSchema = z.preprocess(
  (value) => {
    if (value != null && typeof value === "object" && "can" in value && !("abilityClaim" in value)) {
      const { can, ...rest } = value as { can: unknown };
      return { ...rest, abilityClaim: can };
    }
    return value;
  },
  z.object({
    name: z.string().trim().min(1),
    description: z.string().default(""),
    importPath: z.string().trim().min(1),
    abilityClaim: z.array(z.string()).default([]),
    multiplicity: z.enum(["add-by-default", "add-as-secondary"]).default("add-as-secondary"),
  }),
);
const declaredCommandSchema = z.object({
  description: z.string().default(""),
  importPath: z.string().trim().min(1),
});
const advertisedModuleSchema = z.object({
  importPath: z.string().trim().min(1),
});
/** Session / project / global Scheme state modules. Unknown scopes are a load error. */
export const pluginStateSchema = z
  .object({
    session: z.string().trim().min(1).optional(),
    project: z.string().trim().min(1).optional(),
    global: z.string().trim().min(1).optional(),
  })
  .strict();
/** MCP server record. Not a filesystem path. */
export const pluginMcpSchema = z
  .object({
    name: z.string().trim().min(1),
    command: z.string().trim().min(1).optional(),
    args: z.array(z.string()).optional(),
    visibility: z.enum(["private", "public"]).default("private"),
    scope: z.enum(["session", "workspace", "global"]).optional(),
  })
  .strict();
export const inhumanExtensionSchema = z.object({
  plugins: z.array(advertisedModuleSchema).default([]),
  commands: z.record(z.string(), declaredCommandSchema).default({}),
  drivers: z.array(advertisedDriverSchema).default([]),
  bots: z.array(z.string().trim().min(1)).default([]),
  skills: z.array(z.string().trim().min(1)).default([]),
  /** Behavior program of model tools. Loaded when the plugin is enabled, without a bot pin. */
  abi: z.string().trim().min(1).optional(),
  states: pluginStateSchema.optional(),
  mcp: z.array(pluginMcpSchema).default([]),
});
const extensionsSchema = z
  .object({
    "tools.inhuman": inhumanExtensionSchema.prefault({}),
  })
  .prefault({});
export const pluginManifestSchema = z.object({
  extensions: extensionsSchema,
});

export const packageJsonPeekSchema = z
  .object({
    name: z.unknown().optional(),
    version: z.unknown().optional(),
    dependencies: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export const pluginJsonNameSchema = z
  .object({
    name: z.string().trim().min(1),
  })
  .passthrough();
export const consentedPluginSchema = z
  .object({
    pluginName: z.string().min(1),
    sourceNpm: z.string().default(""),
    sourceVersion: z.string().default(""),
    rootPath: z.string(),
    enabled: z.boolean(),
    extensions: extensionsSchema,
  })
  .transform((row) => ({
    pluginName: row.pluginName,
    sourceNpm: row.sourceNpm,
    sourceVersion: row.sourceVersion,
    rootPath: row.rootPath,
    enabled: row.enabled,
    modules: [] as string[],
  }));
export const loadedCommandSchema = z.object({
  verb: z.string().min(1),
  description: z.string(),
  source: z.string().min(1),
  body: z.string(),
});
export type AdvertisedDriver = z.infer<typeof advertisedDriverSchema>;
export type LoadedCommand = z.infer<typeof loadedCommandSchema>;
