import { clampChars, SESSION_TITLE_MAX_CHARS, SESSION_DESCRIPTION_MAX_CHARS } from "@inhuman.tools/activity";
import { z } from "zod";

import { contextNeedAdmitSchema } from "../schemas/context-need.js";
import { argsJsonValue } from "../schemas/json-record.js";
import { ProgrammaticJob } from "./jobs/ProgrammaticJob.js";
import { ToolCallJob } from "./jobs/ToolCallJob.js";

export const SESSION_METADATA_PLUGIN_ID = "metadata";

export const sessionMetadataActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("context-need"), need: contextNeedAdmitSchema }),
  z.object({
    type: z.literal("metadata-updated"),
    title: z
      .string()
      .trim()
      .min(1)
      .transform((text) => clampChars(text, SESSION_TITLE_MAX_CHARS)),
    description: z
      .string()
      .trim()
      .transform((text) => clampChars(text, SESSION_DESCRIPTION_MAX_CHARS)),
  }),
]);

export type SessionMetadataAction = z.infer<typeof sessionMetadataActionSchema>;

const envelopeSchema = z.object({ action: sessionMetadataActionSchema });

/** Only successful executions contribute session metadata to the surviving trajectory. */
export function sessionMetadataActionOf(job: ToolCallJob): SessionMetadataAction | null {
  if (job.outcomeSnap?.ok !== true) return null;
  const parsed = envelopeSchema.safeParse(argsJsonValue(job.pluginMeta[SESSION_METADATA_PLUGIN_ID]));
  return parsed.success ? parsed.data.action : null;
}

/** Program calls contribute their executed inner tools at their position on the tape. */
export function metadataJobsIn(node: unknown): ToolCallJob[] {
  if (node instanceof ToolCallJob) return [node];
  if (node instanceof ProgrammaticJob) return node.children.flatMap(metadataJobsIn);
  return [];
}
