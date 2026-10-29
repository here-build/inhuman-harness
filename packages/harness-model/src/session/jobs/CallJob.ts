/** A correlated request/reply operation. Subclasses own execution and worker lifetime. */
import { syncing } from "@here.build/plexus";
import { type JobKind } from "@inhuman.tools/plexus-expectations";
import { computed } from "mobx";
import type { ReadonlyDeep } from "type-fest";

import { AgentCallNotification, rememberJobResult } from "./AgentCallNotification.js";
import { CALL_FAIL_CODES, FailureOutcome, SuccessfulOutcome, type CallOutcome } from "./CallOutcome.js";
import { ToolCallJob, type ToolCallJobProps } from "./ToolCallJob.js";
import { serializingInto } from "../../json-record.js";
import { type ToolOutcomeSnap } from "../../schemas/index.js";
import { parseToolOutcome } from "../tool-outcome.js";

/** A call's receipt is {@link CallJob.outcome}, so `outcomeJson` is not a prop. */
export type CallJobProps = Omit<ToolCallJobProps, "outcomeJson"> & {
  readonly workerSessionId?: string;
  readonly voidLegal?: boolean;
  readonly readonly?: boolean;
  readonly responseSchema?: Readonly<Record<string, unknown>> | null;
  readonly outcome?: CallOutcome | null;
  readonly notifications?: readonly AgentCallNotification[];
};

@syncing("harness:job:call")
export abstract class CallJob extends ToolCallJob {
  @syncing accessor workerSessionId: string = "";
  /** False on ask. Default true preserves existing send calls. */
  @syncing accessor voidLegal: boolean = true;
  /** Restrict the responding worker's Scheme desk. */
  @syncing accessor readonly: boolean = false;
  @syncing accessor responseSchemaJson: string | null = null;
  /**
   * Hops behind the caller once this call starts: agent spawns for `agent/ask`, bot hops for
   * `bot/ask`. Recorded with {@link depthLimit}, never recomputed.
   */
  @syncing accessor depth: number = 0;
  /** Cap in force when the call started. Null until stamped; 0 is unlimited. */
  @syncing accessor depthLimit: number | null = null;
  @syncing.child accessor outcome: CallOutcome | null = null;
  @syncing.child.list accessor notifications: AgentCallNotification[] = [];

  constructor(props?: CallJobProps | symbol) {
    if (props == null || typeof props === "symbol") {
      super(props);
      return;
    }
    const { responseSchema, ...rest } = props;
    // `JSON.stringify(null)` is the string "null", which would read back as a schema.
    const init = { ...rest, responseSchemaJson: responseSchema == null ? null : JSON.stringify(responseSchema) };
    super(init);
  }

  override get kind(): JobKind {
    return "agent";
  }

  override get isTrackedBackground(): boolean {
    return this.background;
  }

  override get object(): string {
    return this.name;
  }

  @computed
  override get commFirst(): boolean {
    return true;
  }

  /** JSON Schema for this call's response. Null is unstructured. */
  @serializingInto("responseSchemaJson")
  accessor responseSchema: ReadonlyDeep<Record<string, unknown>> | null = null;

  /** Record depth and its cap the first time the call runs. A rerun after restart keeps them. */
  @syncing.action
  stampDepth(depth: number, limit: number): void {
    if (this.depthLimit != null) return;
    this.depth = depth;
    this.depthLimit = limit;
  }

  /** First outcome wins. A reply after a cancel completes the call with the cancel. */
  @syncing.action
  settleResult(outcome: CallOutcome): boolean {
    if (this.completed) return false;
    const first = this.outcome == null;
    if (first) this.outcome = outcome;
    this.markComplete();
    return first;
  }

  /** Every terminal path ends here, so a background call posts its result once. */
  @syncing.action
  override markComplete(now = Date.now()): void {
    if (!this.completed) rememberJobResult(this, outcomeText(this.outcome));
    super.markComplete(now);
  }

  /** {@link outcome} as a receipt. A call never writes `outcomeJson`. */
  override get receiptJson(): string | null {
    const outcome = this.outcome;
    if (outcome instanceof SuccessfulOutcome) return JSON.stringify({ ok: true, value: outcome.value });
    if (outcome instanceof FailureOutcome) {
      return JSON.stringify({ ok: false, text: outcome.message, code: outcome.code });
    }
    return null;
  }

  override set receiptJson(next: string | null) {
    const snap = parseToolOutcome(next);
    this.outcome = snap == null ? null : outcomeOf(snap);
  }

  /** The receipt, else a background ack. The ack is not the outcome. */
  override sealedOutcomeJson(): string | null {
    const receipt = this.receiptJson;
    if (receipt != null) return receipt;
    if (this.background && this.toolCallId.trim() !== "") {
      return JSON.stringify({ ok: true, value: { job_id: this.toolCallId, background: true } });
    }
    return null;
  }

  @computed
  override get outcomeSnap(): ToolOutcomeSnap | undefined {
    return parseToolOutcome(this.sealedOutcomeJson());
  }

  override set outcomeSnap(next: ToolOutcomeSnap) {
    this.outcome = outcomeOf(next);
  }

  override observationPayload(): unknown {
    const snap = this.outcomeSnap;
    if (snap === undefined) return "";
    if (!snap.ok) return snap.text ?? "";
    return "value" in snap ? snap.value : (snap.text ?? "");
  }
}

function outcomeOf(snap: ToolOutcomeSnap): CallOutcome {
  if (snap.ok) {
    const settled = new SuccessfulOutcome();
    settled.value = "value" in snap ? snap.value : (snap.text ?? null);
    return settled;
  }
  const code = CALL_FAIL_CODES.find((known) => known === snap.code);
  return new FailureOutcome({ code, message: snap.text ?? "" });
}

function outcomeText(outcome: CallOutcome | null): string {
  if (outcome instanceof FailureOutcome) return outcome.message === "" ? outcome.code : outcome.message;
  return outcome?.valueText() ?? "";
}
