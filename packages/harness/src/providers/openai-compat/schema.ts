import { z } from "zod";

import { parseJsonUnknown } from "./json-read.js";

function headersRecord() {
  return z.preprocess(
    (value: unknown) => {
      if (typeof value !== "string") return value;
      try {
        return parseJsonUnknown(value);
      } catch {
        return value;
      }
    },
    z.record(z.string(), z.string()),
  );
}

export const openaiCompatConfigurationSchema = z.looseObject(
  {
    baseUrl: z
      .string({ error: "baseUrl must be a non-empty string" })
      .trim()
      .min(1, "baseUrl must be a non-empty string"),
    model: z.string({ error: "model must be a string" }).optional(),
    temperature: z
      .number({ error: "temperature must be a finite number in [0, 2]" })
      .refine((n) => Number.isFinite(n) && n >= 0 && n <= 2, "temperature must be a finite number in [0, 2]")
      .optional(),
    headers: headersRecord().optional(),
    /**
     * Anthropic `cache_control` breakpoints. `auto` (default) emits them for
     * Anthropic models on OpenRouter; `on` forces them on any Chat route that
     * forwards the field to Anthropic; `off` never emits.
     */
    cacheControl: z.enum(["auto", "on", "off"]).optional(),
    /** TTL of the stable (system, card) breakpoints. Default `5m`; `1h` writes at 2x. */
    cacheControlTtl: z.enum(["5m", "1h"]).optional(),
    /** Off by default: the probe costs two completion calls at bootstrap. */
    cacheProbe: z.boolean().optional(),
    /**
     * Manual context window when the server omits it from /models, keyed by
     * `${connectionId}:${model}`. Atria omits `context_length` entirely.
     */
    contextWindow: z
      .record(z.string(), z.number({ error: "contextWindow values must be numbers" }).int().positive())
      .optional(),
  },
  { error: "config must be an object" },
);

export type OpenaiCompatConnectionConfig = z.output<typeof openaiCompatConfigurationSchema>;

export const openaiCompatSecretsSchema = z.looseObject({
  apiKey: z.string({ error: "apiKey must be a string" }).optional(),
});
