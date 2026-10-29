import type { CompactJob, CompletionJob, ProgrammaticJob, ToolCallJob } from "@inhuman.tools/harness-model";
import type { CompleteRequest, CompleteResult } from "@inhuman.tools/harness-provider-sdk";

import { runCompactJob, type CompactHost } from "@/session";

/** Resolution changes the work node. The iterator reads that node afterward. */
export interface TurnResolvers {
  completion(job: CompletionJob, signal: AbortSignal): Promise<void>;
  work(job: ToolCallJob | ProgrammaticJob, signal: AbortSignal): Promise<"settled" | "aborted">;
  compact(job: CompactJob, signal: AbortSignal): Promise<void>;
}

export interface TurnResolverHost {
  complete(request: CompleteRequest): Promise<CompleteResult>;
  join(job: ToolCallJob | ProgrammaticJob, signal: AbortSignal): Promise<"settled" | "aborted">;
  compactHost(): CompactHost;
}

/** Production effects; tests substitute this whole strategy without a daemon. */
export function createTurnResolvers(host: TurnResolverHost): TurnResolvers {
  return {
    async completion(job, signal) {
      const pew = job.expectation;
      if (pew == null || pew.isDone) return;
      try {
        await host.complete({
          connectionId: pew.connectionId,
          model: pew.model,
          promptText: pew.userPrompt,
          round: pew,
          signal,
        });
      } catch (error) {
        // A park aborts with the reason "park" and leaves the round open for the next wrap.
        if (!signal.aborted && pew.outcome == null && error !== "park") {
          pew.fail("crash", error instanceof Error ? error.message : String(error), "null");
        }
      }
    },
    work: (job, signal) => host.join(job, signal),
    compact: (job, signal) => runCompactJob(job, host.compactHost(), signal),
  };
}
