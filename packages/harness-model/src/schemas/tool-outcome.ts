import { z } from "zod";

export const toolOutcomeSnapSchema = z.object({
  ok: z.boolean(),
  text: z.string().optional(),
  /** Denial sentence. Absent on success and on cancel. Older denials stored it only in `text`. */
  refusalReason: z.string().optional(),
  value: z.unknown().optional(),
  truncated: z.boolean().optional(),
  /** Absent on older outcomes. Failure codes are optional and open-ended. */
  code: z.string().optional(),
  /** Additive structured last value. Absent on display-only scalars. */
  json: z.unknown().optional(),
  /** Last value is not JSON-compatible (`--format json` fails). */
  jsonError: z.string().optional(),
});
export type ToolOutcomeSnap = z.infer<typeof toolOutcomeSnapSchema>;
