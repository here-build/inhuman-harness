/** Read a sealed result back from the session graph, paged. */
import { documentRoot, SessionRoot, ToolCallJob } from "@inhuman.tools/harness-model";
import { InhumanTool } from "@inhuman.tools/plugin-sdk";
import { recallContextAsync } from "@inhuman.tools/turn/tool-runtime";
import invariant from "tiny-invariant";
import { z } from "zod";

import { toolResultSchema } from "../schemas/tool-result.js";

export const CONTEXT_RECALL_TOOL_NAME = "context_recall";

export const contextRecallTool = new InhumanTool({
  name: CONTEXT_RECALL_TOOL_NAME,
  description:
    "Fetch a paged tool result, visual, or owned worker log via Arrival's smart serializer. Large outputs are not dropped — they are shown as abbreviated pointers like `[… elided … — recall job:ab12cd34]` to prevent data dumps; the full sealed result stays in the session graph and is readable here in pages. Use offset/length to page (default/max 5000 chars). A `job:<id>#args` ref reads the original call args, `visual:<id>` reads an image, and `agent:<workerSessionId>` or `job:<id>#log` reads an owned worker's status and execution log.",
  class: "read",
  representation: "both",
  input: z.object({
    ref: z.string().describe("A ref: job:<id>, job:<id>#args, job:<id>#log, agent:<workerSessionId>, or visual:<id>."),
    offset: z.number().int().nonnegative().optional().describe("Character offset to start at. Default 0."),
    length: z.number().int().positive().optional().describe("Characters to return. Default and maximum 5000."),
  }),
  output: toolResultSchema,
  run: (input, ctx) => {
    const session = ctx.invocation instanceof ToolCallJob ? documentRoot(ctx.invocation) : undefined;
    invariant(session instanceof SessionRoot, "context_recall requires a session invocation");
    return recallContextAsync(session, input);
  },
});
