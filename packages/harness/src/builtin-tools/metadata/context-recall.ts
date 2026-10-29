/**
 * Read a sealed result back from the session graph, paged. Stubs in the
 * model input carry the ref. The body runs in the turn package
 * (`recallContext`): it needs the session graph, not a plugin context.
 */
import { InhumanTool } from "@inhuman.tools/plugin-sdk";
import { z } from "zod";

import { toolResultSchema } from "../schemas/tool-result.js";

export const CONTEXT_RECALL_TOOL_NAME = "context_recall";

export const contextRecallTool = new InhumanTool({
  name: CONTEXT_RECALL_TOOL_NAME,
  description:
    "Read back a tool result or picture that was elided from your context. Elisions look like `[… elided … — recall job:ab12cd34]` or `recall visual:<id>`; pass that ref. Large results come back in pages: use offset and length (characters) to continue. A `job:<id>#args` ref reads a call's full arguments. Files may have changed since they were read; re-read for current content.",
  class: "read",
  representation: "both",
  input: z.object({
    ref: z.string().describe("A ref from an elision: job:<id>, job:<id>#args, or visual:<id>."),
    offset: z.number().int().nonnegative().optional().describe("Character offset to start at. Default 0."),
    length: z.number().int().positive().optional().describe("Characters to return. Default and maximum 5000."),
  }),
  output: toolResultSchema,
  run: () => ({ ok: true as const, value: "" }),
});
