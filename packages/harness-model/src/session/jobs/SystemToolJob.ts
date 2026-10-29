/**
 * Native tool call. Identity and receipt live on {@link ToolCallJob}.
 * BODY is the Job executor after an allow-side guard.
 * {@link FileMutateToolJob} is the write_file / edit_file slice.
 */
import { syncing } from "@here.build/plexus";
import { type JobEffectOwner, type JobKind, type UnknownOutcomeRecovery } from "@inhuman.tools/plexus-expectations";

import { AgentCallNotification, rememberJobResult, RESULT_NOTE_CHARS } from "./AgentCallNotification.js";
import { ToolCallJob, type ToolCallJobProps } from "./ToolCallJob.js";
import { parseStoredBlob, type PriorText } from "../blob-ref.js";
import { finishedText, outcomeText } from "../tool-outcome.js";

@syncing("harness:job:system-tool")
export class SystemToolJob extends ToolCallJob {
  override readonly owner: JobEffectOwner = "tool-runtime";
  override readonly intent: string =
    "Record job/attempt identity, runtime generation, name, argsJson; await a durable receipt covering that prefix (including orchestrationResult) before BODY.";
  override readonly checkpoint: string =
    "session document. orchestrationResult in the durable prefix distinguishes queued from a potentially executed attempt.";
  override readonly dispatch: string =
    "executeSystemTool after an allow-side guard. Recheck cancel/eligibility/approval after the receipt.";
  override readonly settlement: string =
    "outcomeJson + completed. Until settlement is durable, restart recovers unknown.";
  override readonly cancel: string =
    "Abort parkable work with a cancel receipt. Do not start BODY when already aborted. Park does not replay.";
  override readonly unknownRecovery: UnknownOutcomeRecovery = "unknown-no-replay";
  override readonly unknownNote: string =
    "Durable unsettled intent completes as unknown. Catalog regeneratable reads may re-invoke; unknown ops default non-idempotent. Do not mint a new attempt.";
  override readonly intentRequired: boolean = true;

  /** Background shell completion. Calls and programs use their notify list instead. */
  @syncing.child accessor resultNote: AgentCallNotification | null = null;

  /** Every terminal path ends here, so a background shell posts its result once. */
  @syncing.action
  override markComplete(now = Date.now()): void {
    if (!this.completed) {
      const snap = this.outcomeSnap;
      rememberJobResult(
        this,
        finishedText(this, snap, () => (snap == null ? "" : outcomeText(snap))),
        RESULT_NOTE_CHARS,
      );
    }
    super.markComplete(now);
  }

  override get kind(): JobKind {
    return "command";
  }

  override get isTrackedBackground(): boolean {
    return this.background && this.name === "shell";
  }

  override get object(): string {
    const command = this.args?.command;
    const text = typeof command === "string" ? command.replaceAll(/\s+/g, " ").trim().slice(0, 120) : "";
    return text || this.name;
  }
}

/**
 * write_file / edit_file. Native BODY still matches {@link SystemToolJob}
 * (`registerExecutor` is `instanceof`). Prior is a host-injected tape fact —
 * not a model argument, not outcomeJson.
 *
 * Leftover docs stay `harness:job:system-tool`. Paint falls back to tape.
 */
@syncing("harness:job:file-mutate")
export class FileMutateToolJob extends SystemToolJob {
  override readonly owner: JobEffectOwner = "tool-runtime";
  override readonly intent: string =
    "Same as SystemToolJob. priorContent / existed / priorLineStart are tape facts, not intent receipts.";
  override readonly checkpoint: string =
    "session document prefix including orchestrationResult and identity. prior* is not coverage.";
  override readonly dispatch: string = "write_file / edit_file BODY through the SystemToolJob executor (instanceof).";
  override readonly settlement: string = "outcomeJson + squeeze + completed.";
  override readonly cancel: string = "Same as SystemToolJob. An unstarted write does not run.";
  override readonly unknownRecovery: UnknownOutcomeRecovery = "unknown-no-replay";
  override readonly unknownNote: string =
    "Writes are never auto-replayed. Interrupted BODY is unknown, not queued work.";
  override readonly intentRequired: boolean = true;

  /**
   * write_file: path was a file at admit. Null = not stamped (old docs).
   * Paint injects this as pretty-mcp `existed`; BODY may still door.
   */
  @syncing accessor existed: boolean | null = null;
  /**
   * UTF-8 prior bytes at admit / apply, when they fit inline (`BLOB_INLINE_MAX_CHARS`).
   * Null = missing, binary, over the read budget, or externalized to {@link priorBlobJson}.
   */
  @syncing accessor priorContent: string | null = null;
  /**
   * The prior text's blob reference (a `StoredBlob` as JSON) when it was too large to stay
   * inline. At most one of {@link priorContent} and this is non-null. Old documents have neither
   * or only `priorContent`.
   */
  @syncing accessor priorBlobJson: string | null = null;
  /**
   * 1-based file line of `edit_file` `old_string`. Null when the span is missing or already line 1.
   * Survives when the TUI replica has the span but not {@link priorContent}.
   */
  @syncing accessor priorLineStart: number | null = null;

  /** The captured prior text, inline or by reference. Null when none was captured. */
  get prior(): PriorText | null {
    if (typeof this.priorContent === "string") return { kind: "inline", text: this.priorContent };
    const blob = parseStoredBlob(this.priorBlobJson);
    return blob === null ? null : { kind: "blob", blob };
  }

  constructor(
    props?:
      | (ToolCallJobProps & {
          readonly existed?: boolean | null;
          readonly priorContent?: string | null;
          readonly priorBlobJson?: string | null;
          readonly priorLineStart?: number | null;
        })
      | symbol,
  ) {
    if (typeof props === "object" && props !== null) {
      const { existed, priorContent, priorBlobJson, priorLineStart, ...rest } = props;
      super(rest);
      if (existed !== undefined) this.existed = existed;
      if (priorContent !== undefined) this.priorContent = priorContent;
      if (priorBlobJson !== undefined) this.priorBlobJson = priorBlobJson;
      if (priorLineStart !== undefined) this.priorLineStart = priorLineStart;
      return;
    }
    super(props);
  }
}
