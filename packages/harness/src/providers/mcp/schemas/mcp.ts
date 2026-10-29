import { z } from "zod";

import { asRecord, readField } from "../json.js";

export const mcpSecretsSchema = z
  .object({
    token: z.string({ error: "token must be a string" }).optional(),
    apiKey: z.string({ error: "apiKey must be a string" }).optional(),
  })
  .passthrough();

export const mcpToolRulesSchema = z
  .array(z.string({ error: "tools entries must be strings" }), {
    error: "tools must be a string array",
  })
  .optional();

export const mcpAlwaysAllowSchema = z
  .array(z.string({ error: "alwaysAllow entries must be strings" }), {
    error: "alwaysAllow must be a string array",
  })
  .optional();

export const mcpToolSeveritySchema = z
  .record(
    z.string(),
    z.enum(["view", "effect", "irreversible-effect"], {
      error: "toolSeverity values must be view, effect, or irreversible-effect",
    }),
    { error: "toolSeverity must be an object" },
  )
  .optional();

export const mcpStdioConfigurationSchema = z
  .object(
    {
      command: z
        .string({ error: "command must be a non-empty string" })
        .trim()
        .min(1, "command must be a non-empty string"),
      args: z.array(z.string(), { error: "args must be a string array" }).optional(),
      /** Harness base (kernel / install) directory. Not SessionRoot.path. */
      cwd: z.string({ error: "cwd must be a string" }).optional(),
      enabled: z.boolean({ error: "enabled must be a boolean" }).optional().default(true),
      envForward: z.array(z.string(), { error: "envForward must be a string array" }).optional(),
      tools: mcpToolRulesSchema,
      toolSeverity: mcpToolSeveritySchema,
      /** Durable Always-as-read names. Not a license without the read floor. */
      alwaysAllow: mcpAlwaysAllowSchema,
    },
    { error: "config must be an object" },
  )
  .passthrough();

export type McpStdioConnectionConfig = z.output<typeof mcpStdioConfigurationSchema>;

export const mcpHttpConfigurationSchema = z
  .object(
    {
      url: z.string({ error: "url must be a non-empty string" }).trim().min(1, "url must be a non-empty string"),
      headers: z
        .record(z.string(), z.string(), {
          error: "headers must be a string record",
        })
        .optional(),
      enabled: z.boolean({ error: "enabled must be a boolean" }).optional().default(true),
      tools: mcpToolRulesSchema,
      toolSeverity: mcpToolSeveritySchema,
      alwaysAllow: mcpAlwaysAllowSchema,
    },
    { error: "config must be an object" },
  )
  .passthrough();

export type McpHttpConnectionConfig = z.output<typeof mcpHttpConfigurationSchema>;

/** One tool as a connection reports it on `spec.live.tools`. */
export type McpListedTool = {
  readonly serverToolName: string;
  readonly description?: string;
  readonly parameters: Record<string, unknown>;
  readonly class?: string;
};

export function parseListedTool(item: unknown): McpListedTool | undefined {
  if (typeof item !== "object" || item === null) return undefined;
  const serverToolName = readField(item, "serverToolName");
  if (typeof serverToolName !== "string" || serverToolName === "") return undefined;
  const parameters = asRecord(readField(item, "parameters")) ?? {
    type: "object",
    properties: {},
  };
  const description = readField(item, "description");
  const cls = readField(item, "class");
  return {
    serverToolName,
    parameters,
    ...(typeof description === "string" ? { description } : {}),
    ...(typeof cls === "string" ? { class: cls } : {}),
  };
}

export function parseListedTools(raw: unknown): McpListedTool[] {
  if (!Array.isArray(raw)) return [];
  const out: McpListedTool[] = [];
  for (const item of raw) {
    const tool = parseListedTool(item);
    if (tool != null) out.push(tool);
  }
  return out;
}
