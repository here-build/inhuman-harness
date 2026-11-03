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
    "Fetch a paged tool result or visual via Arrival's smart serializer. Large outputs are not dropped — they are shown as abbreviated pointers like `[… elided … — recall job:ab12cd34]` to prevent data dumps; the full sealed result stays in the session graph and is readable here in pages. Use offset/length to page (default/max 5000 chars). A `job:<id>#args` ref reads the original call args, `visual:<id>` reads an image. For current file content, re-read the file directly.",
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
