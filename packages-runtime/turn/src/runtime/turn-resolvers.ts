import type { CompactJob, CompletionJob, ProgrammaticJob, ToolCallJob } from "@inhuman.tools/harness-model/session";
import type { CompleteRequest, CompleteResult } from "@inhuman.tools/harness-provider-sdk";

import { runCompactJob, type CompactHost } from "../session/compact-actor.js";

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
      const expectation = job.expectation;
      if (expectation == null || expectation.isDone) return;
      try {
        await host.complete({
          connectionId: expectation.connectionId,
          model: expectation.model,
          promptText: expectation.userPrompt,
          round: expectation,
          signal,
        });
      } catch (error) {
        // A park aborts with the reason "park" and leaves the round open for the next wrap.
        if (!signal.aborted && expectation.outcome == null && error !== "park") {
          expectation.fail("crash", error instanceof Error ? error.message : String(error), "null");
        }
      }
    },
    work: (job, signal) => host.join(job, signal),
    compact: (job, signal) => runCompactJob(job, host.compactHost(), signal),
  };
}
