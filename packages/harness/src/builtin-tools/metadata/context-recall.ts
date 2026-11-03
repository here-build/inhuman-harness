/** Read a sealed result back from the session graph, paged. */
import invariant from "tiny-invariant";
import { documentRoot, SessionRoot, ToolCallJob } from "@inhuman.tools/harness-model";
import { InhumanTool } from "@inhuman.tools/plugin-sdk";
import { recallContext } from "@inhuman.tools/turn/tool-runtime";
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
  run: (input, ctx) => {
    const session = ctx.invocation instanceof ToolCallJob ? documentRoot(ctx.invocation) : undefined;
    invariant(session instanceof SessionRoot, "context_recall requires a session invocation");
    return recallContext(session, input);
  },
});
