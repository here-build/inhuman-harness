import {
  CONTEXT_NEED_FOCUS_MAX_CHARS,
  CONTEXT_NEED_PRESERVE_MAX,
  CONTEXT_NEED_TOKENS_MAX,
} from "@inhuman.tools/activity";
import { z } from "zod";

import { argsJsonValue } from "./json-record.js";

function clampInt(value: number, max: number): number {
  return Math.min(value, max);
}

const boundedInt = (max: number) =>
  z
    .number()
    .int()
    .nonnegative()
    .transform((n) => clampInt(n, max));

export const contextNeedAdmitSchema = z.preprocess(
  argsJsonValue,
  z
    .object({
      min_remaining_tokens: boundedInt(CONTEXT_NEED_TOKENS_MAX).optional(),
      preserve: z
        .object({
          user_turns: boundedInt(CONTEXT_NEED_PRESERVE_MAX).optional(),
          rounds: boundedInt(CONTEXT_NEED_PRESERVE_MAX).optional(),
        })
        .optional(),
      focus: z.string().optional(),
      current_phase_settled: z.literal(true).optional(),
    })
    .superRefine((rec, ctx) => {
      if (rec.min_remaining_tokens === undefined && rec.current_phase_settled !== true) {
        ctx.addIssue({ code: "custom", message: "min_remaining_tokens or current_phase_settled" });
      }
    })
    .transform((rec) => {
      const rawFocus = rec.focus === undefined ? undefined : rec.focus.trim();
      const focus =
        rawFocus === undefined || rawFocus === ""
          ? undefined
          : [...rawFocus].length <= CONTEXT_NEED_FOCUS_MAX_CHARS
            ? rawFocus
            : [...rawFocus].slice(0, CONTEXT_NEED_FOCUS_MAX_CHARS).join("");
      const preserve =
        rec.preserve !== undefined && (rec.preserve.user_turns !== undefined || rec.preserve.rounds !== undefined)
          ? rec.preserve
          : undefined;
      return {
        ...(rec.min_remaining_tokens === undefined ? {} : { min_remaining_tokens: rec.min_remaining_tokens }),
        ...(preserve === undefined ? {} : { preserve }),
        ...(focus === undefined ? {} : { focus }),
        ...(rec.current_phase_settled === true ? { current_phase_settled: true as const } : {}),
      };
    }),
);

export {
  CONTEXT_NEED_FOCUS_MAX_CHARS,
  CONTEXT_NEED_TOKENS_MAX,
  CONTEXT_NEED_PRESERVE_MAX,
} from "@inhuman.tools/activity";
