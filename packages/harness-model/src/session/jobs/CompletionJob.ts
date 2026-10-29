/**
 * Tape/program/judge cell that owns a CompletionExpectation. Sequence is
 * this Job; honor walks `.work`.
 */
import { syncing } from "@here.build/plexus";
import {
  Job,
  type JobEffectOwner,
  type JobResolution,
  type UnknownOutcomeRecovery,
  type WorkContainer,
} from "@inhuman.tools/plexus-expectations";
import { computed } from "mobx";

import type { CompletionExpectation } from "../expectations/CompletionExpectation.js";

/** Predecessor this cell continues. Ref, not `@syncing.child` — child would reparent X. */
type CompletionJobTail = Job;

@syncing("harness:job:completion")
export class CompletionJob extends Job<unknown, string> {
  override readonly owner: JobEffectOwner = "honor";
  override readonly intent: string =
    "Record job/PEW identity, runtime generation, connection, prompt; await a durable receipt before connection.complete. Honor leftover only if that attempt already started.";
  override readonly checkpoint: string =
    "session document prefix on the CompletionJob / CompletionExpectation. A queued outbound HTTP is not a receipt.";
  override readonly dispatch: string =
    "Origin internedComplete or honor handle of leftover attach PEW. Origin-dispatched PEW skip honor.";
  override readonly settlement: string = "expectation.isDone; Job completed.";
  override readonly cancel: string =
    "Abort in-flight request; fail open PEW. Do not start a new attempt for the same job.";
  override readonly unknownRecovery: UnknownOutcomeRecovery = "unknown-no-replay";
  override readonly unknownNote: string =
    "Same attempt is not auto-retried after owner death. A new CompletionJob is a new attempt.";
  override readonly intentRequired: boolean = true;

  @syncing.child accessor expectation!: CompletionExpectation;
  @syncing accessor turnTail: CompletionJobTail | null = null;
  /** Prefix already summarized. The same key does not start another summarizer. */
  @syncing accessor ambientCompactKey: string = "";

  constructor(
    props:
      | {
          readonly expectation: CompletionExpectation;
          readonly turnTail?: CompletionJobTail | null;
          readonly background?: boolean;
          readonly walkBoundary?: boolean;
          readonly orchestrationResult?: true | false | null;
          readonly cancelled?: boolean;
          readonly completed?: boolean;
        }
      | symbol,
  ) {
    super(props);
  }

  @computed
  override get result(): JobResolution<unknown, string> | null {
    const expectation = this.expectation;
    if (!expectation.isDone) return null;
    if (expectation.outcome !== "successful") {
      return {
        status: "rejected",
        reason: expectation.failReason ?? expectation.endDetail ?? "completion failed",
      };
    }
    if (expectation.responseSchema == null) return { status: "fulfilled", value: expectation.responseText };
    try {
      const value: unknown = JSON.parse(expectation.responseText);
      return { status: "fulfilled", value };
    } catch (error) {
      const reason = error instanceof Error ? error.message : "completion failed";
      return { status: "rejected", reason };
    }
  }

  @computed
  override get work(): readonly WorkContainer[] {
    return [this.expectation];
  }
}

export function tapeCompletion(chunk: unknown): CompletionExpectation | null {
  return chunk instanceof CompletionJob ? chunk.expectation : null;
}
