import type { Dialect, ExtractResult } from "../types.js";

export const openaiDialect: Dialect = {
  id: "openai",
  markers: [],
  autoPriority: 1000,
  allowAuto: false,
  allowStreamAuto: false,
  extract(text): ExtractResult {
    return { content: text || null, raw_calls: [], toolSpans: [] };
  },
};
