/**
 * Compact cutoff resolved when the sequence iterator reaches it, after tools.
 *
 * The element is not "start here." A successful job means everything strictly
 * before it is replaced on the wire: the card is the summary, the squeeze band
 * is stored tool lines, the keep band stays verbatim. Floors and focus stay on the
 * ContextNeed before the job (else the keep-turns dial). `reason` and the
 * dial reading are facts, because occupancy and config move.
 */
import { syncing } from "@here.build/plexus";
import {
  Job,
  type JobEffectOwner,
  type JobResolution,
  type UnknownOutcomeRecovery,
} from "@inhuman.tools/plexus-expectations";
import { computed } from "mobx";

/** Why this compact ran, recorded before the cutoff changes context. */
export type CompactReason = "overflow" | "need" | "user";

@syncing("harness:job:compact")
export class CompactJob extends Job<string, string> {
  override readonly owner: JobEffectOwner = "session-runtime";
  override readonly intent: string =
    "None for the compact itself. Nested strategy complete() is CompletionJob/PEW and follows that row. CompactJob has no executor.";
  override readonly checkpoint: string = "reason, keepTurns, kvKeepTurns, card, failed, notice on the session document.";
  override readonly dispatch: string =
    "Turn loop runs applyCompact when the chunk is shifted, after tools have settled.";
  override readonly settlement: string =
    "completed. cutoff iff completed && !failed && card !== ''. Failed/empty is not a cutoff.";
  override readonly cancel: string =
    "An incomplete job is not a cutoff. Do not inject the notice into the next prompt.";
  override readonly unknownRecovery: UnknownOutcomeRecovery = "resume-queued";
  override readonly unknownNote: string =
    "Empty card: retry the compact. Nested complete() unknown-no-replay then fail-closed notice. Do not treat a missing card as a successful cutoff.";
  override readonly intentRequired: boolean = false;

  /** Why this compact was enqueued. Not derivable once occupancy moves. */
  @syncing accessor reason: CompactReason = "overflow";
  /**
   * Strategy card text. Empty until a successful cutoff. The wire shows this
   * instead of the replaced rounds — not a cursor into old completions.
   */
  @syncing accessor standIn: string = "";
  /** Human-visible failure. Empty on success. Never a model prompt. */
  @syncing accessor notice: string = "";
  @syncing accessor failed: boolean = false;
  /**
   * `compactKeepTurns` dial, stamped when the job is minted. Null only on a
   * job that was never stamped (hand-built in a test). Preserve widths stay on
   * the ContextNeed, which is itself a fact on the tape; this is the dial
   * reading, because the card only matches the cut taken at that dial.
   * Floors are computed from this and `kvKeepTurns`, never from live settings.
   */
  @syncing accessor keepTurns: number | null = null;
  /**
   * Session kv `compact.keep-turns` as read when the job was minted. 0 = unset
   * or invalid. Stamped together with `keepTurns`: the second input to the cut.
   */
  @syncing accessor kvKeepTurns: number = 0;

  constructor(
    props?:
      | {
          readonly reason?: CompactReason;
          readonly standIn?: string;
          readonly notice?: string;
          readonly failed?: boolean;
          readonly keepTurns?: number | null;
          readonly kvKeepTurns?: number;
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
  override get result(): JobResolution<string, string> | null {
    if (this.endedAtMs == null) return null;
    if (this.failed) return { status: "rejected", reason: this.notice || "compact failed" };
    return { status: "fulfilled", value: this.standIn };
  }

  /** Successful cutoff. A failed or empty job does not move the boundary. */
  @computed
  get cutoff(): boolean {
    return this.completed === true && this.failed !== true && this.standIn !== "";
  }
}
