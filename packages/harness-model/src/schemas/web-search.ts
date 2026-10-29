import { z } from "zod";

import { argsJsonValue } from "./json-record.js";

export const webSearchArgsSchema = z.preprocess(
  argsJsonValue,
  z
    .object({
      query: z.unknown().optional(),
      q: z.unknown().optional(),
      numResults: z.unknown().optional(),
      limit: z.unknown().optional(),
    })
    .passthrough()
    .transform((rec) => {
      const query = (typeof rec.query === "string" ? rec.query : typeof rec.q === "string" ? rec.q : "").trim();
      const raw = rec.numResults ?? rec.limit;
      const limit = typeof raw === "number" && Number.isFinite(raw) ? Math.min(10, Math.max(1, Math.trunc(raw))) : 5;
      return { query, limit };
    }),
);
