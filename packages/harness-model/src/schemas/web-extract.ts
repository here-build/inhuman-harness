import { z } from "zod";

import { argsJsonValue } from "./json-record.js";

export const DEFAULT_EXTRACT_CHAR_LIMIT = 15_000;

export const webExtractArgsSchema = z.preprocess(
  argsJsonValue,
  z
    .object({
      url: z.unknown().optional(),
      uri: z.unknown().optional(),
      charLimit: z.unknown().optional(),
      char_limit: z.unknown().optional(),
      maxChars: z.unknown().optional(),
    })
    .passthrough()
    .transform((rec) => {
      const url = (typeof rec.url === "string" ? rec.url : typeof rec.uri === "string" ? rec.uri : "").trim();
      const raw = rec.charLimit ?? rec.char_limit ?? rec.maxChars;
      const charLimit =
        typeof raw === "number" && Number.isFinite(raw)
          ? Math.min(100_000, Math.max(256, Math.trunc(raw)))
          : DEFAULT_EXTRACT_CHAR_LIMIT;
      return { url, charLimit };
    }),
);
