import type { ContextNeed } from "@inhuman.tools/activity";

import { CompactJob } from "./jobs/CompactJob.js";
import { ContextNeedToolJob } from "./jobs/ContextNeedToolJob.js";
import { metadataJobsIn, SESSION_METADATA_PLUGIN_ID, sessionMetadataActionOf } from "./metadata-actions.js";

export { CONTEXT_NEED_TOOL_NAME, type ContextNeed, type ContextNeedPreserve } from "@inhuman.tools/activity";

/**
 * Last committed context request after this tape's last compact cutoff.
 * A failed or unfinished CompactJob does not hide the job.
 * A cutoff with no later action is empty — caller must not inherit.
 * Legacy successful ContextNeedToolJobs remain readable; last valid request wins.
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
    for (const job of metadataJobsIn(chunk).toReversed()) {
      const action = sessionMetadataActionOf(job);
      if (action?.type === "context-need") return action.need;
      if (job.pluginMeta[SESSION_METADATA_PLUGIN_ID] == null && job instanceof ContextNeedToolJob && job.need != null) {
        return job.need;
      }
    }
  }
  if (cutoffAt !== -1) return null;
  return tailNeed;
}
