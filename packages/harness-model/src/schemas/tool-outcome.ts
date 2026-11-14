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

/**
 * Coerce an arbitrary tool return into the canonical outcome snapshot.
 * A well-formed `{ ok: boolean, … }` object is projected field-by-field;
 * anything else becomes a successful opaque value. This is the single source
 * of the coercion — harness builtin-tools and the turn runtime delegate here
 * instead of re-implementing it.
 */
export function asToolOutcome(out: unknown): ToolOutcomeSnap {
  if (out != null && typeof out === "object" && "ok" in out) {
    const row = out as Record<string, unknown>;
    if (typeof row.ok === "boolean") {
      return {
        ok: row.ok,
        ...(typeof row.text === "string" ? { text: row.text } : {}),
        ...(typeof row.refusalReason === "string" ? { refusalReason: row.refusalReason } : {}),
        ...("value" in row ? { value: row.value } : {}),
        ...(row.truncated === true ? { truncated: true } : {}),
        ...(typeof row.code === "string" ? { code: row.code } : {}),
        ...("json" in row ? { json: row.json } : {}),
        ...(typeof row.jsonError === "string" ? { jsonError: row.jsonError } : {}),
      };
    }
  }
  return { ok: true, value: out };
}
