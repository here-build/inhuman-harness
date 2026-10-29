import { z } from "@inhuman.tools/plugin-sdk";

export const toolResultSchema = z.object({
  ok: z.boolean(),
  text: z.string().optional(),
  value: z.unknown().optional(),
  truncated: z.boolean().optional(),
});

export const toolResultShape = z.object({
  ok: z.boolean(),
  text: z.unknown().optional(),
  value: z.unknown().optional(),
  truncated: z.boolean().optional(),
});
