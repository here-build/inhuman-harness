import { CONTEXT_NEED_TOOL_NAME, UPDATE_METADATA_TOOL_NAME, METADATA_SAME_ROUND_TEXT } from "@inhuman.tools/activity";
import { type ToolContinuation } from "@inhuman.tools/harness-commons";
import { z } from "zod";

import { argsJsonValue } from "../schemas/json-record.js";

export type { ToolContinuation } from "@inhuman.tools/harness-commons";

const storedContinuationSchema: z.ZodType<ToolContinuation> = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("observation") }),
  z.strictObject({ kind: z.literal("auxiliary"), note: z.string().trim().min(1).optional() }),
  z.strictObject({ kind: z.literal("none") }),
]);

export type JobContinuationSnapshot = {
  readonly continuationJson?: string;
  readonly triggersReactLoop?: boolean | null;
  readonly name?: string;
  readonly toolName?: string;
};

/** Explicit stamps are authoritative. Invalid stamps cannot authorize another model invocation. */
export function jobContinuationOf(job: JobContinuationSnapshot): ToolContinuation {
  if (job.continuationJson != null && job.continuationJson !== "") {
    const parsed = storedContinuationSchema.safeParse(argsJsonValue(job.continuationJson));
    return parsed.success ? parsed.data : { kind: "none" };
  }
  if (job.triggersReactLoop !== false) return { kind: "observation" };
  const name = job.name ?? job.toolName;
  // Saved calls predate static auxiliary declarations and their recovery notes.
  if (name === UPDATE_METADATA_TOOL_NAME || name === CONTEXT_NEED_TOOL_NAME) {
    return { kind: "auxiliary", note: METADATA_SAME_ROUND_TEXT };
  }
  return { kind: "none" };
}
