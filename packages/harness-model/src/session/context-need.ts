import type { ContextNeed } from "@inhuman.tools/activity";

import { CompactJob } from "./jobs/CompactJob.js";
import { ContextNeedToolJob } from "./jobs/ContextNeedToolJob.js";

export { CONTEXT_NEED_TOOL_NAME, type ContextNeed, type ContextNeedPreserve } from "@inhuman.tools/activity";

/**
 * Last valid ContextNeedToolJob after this tape's last compact cutoff.
 * A failed or unfinished CompactJob does not hide the job.
 * A cutoff with no later job is empty — caller must not inherit.
 * Invalid args skip; last valid wins.
 */
export function contextNeedFromChunks(chunks: readonly unknown[], tailNeed: ContextNeed | null): ContextNeed | null {
  let cutoffAt = -1;
  for (let i = chunks.length - 1; i >= 0; i -= 1) {
    const chunk = chunks[i];
    if (chunk instanceof CompactJob && chunk.cutoff) {
      cutoffAt = i;
      break;
    }
  }
  for (let i = chunks.length - 1; i > cutoffAt; i -= 1) {
    const chunk = chunks[i];
    if (chunk instanceof ContextNeedToolJob) {
      const parsed = chunk.need;
      if (parsed !== null) return parsed;
    }
  }
  if (cutoffAt !== -1) return null;
  return tailNeed;
}
