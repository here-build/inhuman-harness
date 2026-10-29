/**
 * One tool for the jobs the interpreter already tracks. No id lists them.
 * An id cancels that one job. The answer is the job's state, not a second registry.
 */
import { JOB_STOP_TOOL_NAME } from "@inhuman.tools/harness-model";
import { InhumanTool } from "@inhuman.tools/plugin-sdk";
import { z } from "zod";

import { toolResultSchema } from "../schemas/tool-result.js";

export const jobStopTool = new InhumanTool({
  name: JOB_STOP_TOOL_NAME,
  description:
    "List or stop background work. Omit job_id to list the jobs still running (commands, agents, workflows). Pass job_id — the id returned when that work went to the background — to stop that one job. Stopping is permanent. Do not use kill or pkill.",
  class: "meta",
  representation: "symbol",
  input: z.object({
    job_id: z.string().optional().describe("Background job id. Omit to list."),
  }),
  output: toolResultSchema,
  run: () => ({ ok: true as const, value: { jobs: [] } }),
});
