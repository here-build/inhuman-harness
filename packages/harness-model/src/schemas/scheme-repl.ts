import { z } from "zod";

import { optionalDescription } from "./optional-description.js";

export const PERIOD_ERR = 'period must be "N minutes", "N hours", or "N days"';
export const PERIOD_TOKEN = /^([1-9]\d*) (minutes|hours|days)$/;
export const REPL_PERIOD_ERR =
  "scheme_repl runs once and does not accept period. Remove period for ordinary work, including agent/ask. Use scheme_watch only for requested ongoing monitoring; do not add a done condition to make a one-shot call valid.";

export const callArgsSchema = z.object(
  {
    expr: z
      .string({ error: "expr must be a string" })
      .describe("Scheme program. Multiple top-level forms are evaluated in order."),
    timeoutMs: z
      .number({ error: "timeoutMs must be an integer" })
      .int("timeoutMs must be an integer")
      .min(1, "timeoutMs must be >= 1")
      .optional()
      .describe(
        "Optional execution timeout in milliseconds (per iteration for scheme_watch). Omit for no time limit. Does not schedule repetitions.",
      ),
    maxInternalCalls: z
      .number({ error: "maxInternalCalls must be an integer" })
      .int("maxInternalCalls must be an integer")
      .min(1, "maxInternalCalls must be >= 1")
      .optional()
      .describe("Optional inner tool-call budget (per iteration for scheme_watch). Omit for no limit."),
    background: z
      .boolean({ error: "background must be a boolean" })
      .optional()
      .describe(
        "If true, return without waiting for the program to finish; results arrive later as notifications. Applies to the whole program, not individual inner calls. Defaults to false (wait for results). Does not schedule repetitions.",
      ),
    description: optionalDescription("expression"),
  },
  { error: "arguments must be a JSON object" },
);

export const watchArgsSchema = callArgsSchema.extend({
  period: z
    .string({ error: PERIOD_ERR })
    .regex(PERIOD_TOKEN, PERIOD_ERR)
    .describe(
      'Required monitoring interval: "N minutes", "N hours", or "N days". Use only for requested ongoing monitoring or repeated checks over time; choose an appropriate cadence if unspecified. Not a timeout, delay, or agent polling option. Ordinary work belongs in scheme_repl. Each iteration must reach (meta-reactivity/done-condition stop? [result]); true ends the watcher.',
    ),
});

export const callResultSchema = z.union([
  z.object({ ok: z.literal(false), text: z.string() }),
  z.object({ ok: z.boolean(), value: z.array(z.unknown()) }),
]);
