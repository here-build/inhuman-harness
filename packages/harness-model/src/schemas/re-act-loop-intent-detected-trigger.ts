import { z } from "zod";

export const reActLoopIntentDetectedTriggerFlagsSchema = z
  .object({
    enabled: z.unknown().optional(),
    models: z.unknown().optional(),
  })
  .passthrough()
  .transform((rec) => ({
    enabled: rec.enabled === undefined ? true : rec.enabled === true,
    models: parseModelFlags(rec.models),
  }));

function parseModelFlags(raw: unknown): Record<string, boolean> {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key.trim() === "" || typeof value !== "boolean") continue;
    out[key] = value;
  }
  return out;
}
