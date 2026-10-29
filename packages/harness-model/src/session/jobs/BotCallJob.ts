/** A request to an independently managed bot. Acceptance does not settle the request. */
import { syncing } from "@here.build/plexus";
import { type JobEffectOwner, type JobKind, type UnknownOutcomeRecovery } from "@inhuman.tools/plexus-expectations";
import { computed } from "mobx";
import type { ReadonlyDeep } from "type-fest";

import { type CallDelivery } from "./CallDelivery.js";
import { CallJob, type CallJobProps } from "./CallJob.js";
import { parseOutcomeValue, stringifyOutcomeValue } from "./CallOutcome.js";
import { deepFreeze, frozenRecord } from "../../json-record.js";

export type CallDiagnostic = {
  readonly code: string;
  readonly message: string;
  readonly attempts: number;
  readonly recordedAt: number;
};

export type BotCallJobProps = CallJobProps & {
  readonly botName?: string;
  readonly preparedInputJson?: string | null;
  readonly acceptedAt?: number | null;
  readonly contributionPluginName?: string;
  readonly contributionBotName?: string;
  readonly contributionRevision?: string;
  readonly diagnosticJson?: string | null;
  readonly delivery?: CallDelivery | null;
};

@syncing("harness:job:bot-call")
export class BotCallJob extends CallJob {
  override readonly owner: JobEffectOwner = "agent-calls";
  override readonly intent: string =
    "The enqueue into the worker's document, keyed by the call. The worker id derives from the call, so no caller write precedes it. Nested worker effects use their own job intents.";
  override readonly checkpoint: string =
    "worker session document: the inbound turn and the callback row for this call.";
  override readonly dispatch: string =
    "Stamp the caller and enqueue the worker in one action, unless the worker already holds this call's callback row or turn; then flush the worker.";
  override readonly settlement: string =
    "BotCallJob.outcome + completed, written into the caller by the worker's callback. joinReleased follows delivery, not processing.";
  override readonly cancel: string =
    "`call` lifetime skips turn cancel. A turn lease cancels with the turn. Lease revocation removes the grant; it does not erase a durable `call` obligation.";
  override readonly unknownRecovery: UnknownOutcomeRecovery = "resume-inner";
  override readonly unknownNote: string =
    "Re-run the delivery: the derived worker id and its callback row make it idempotent. Nested unknown follows nested rows.";
  override readonly intentRequired: boolean = true;

  /** Resolved target pinned at admission, independent of tool argument spelling. */
  @syncing accessor botName: string = "";
  /** Serialized prepare output, as delivered. */
  @syncing private accessor preparedInputJson: string | null = null;
  /** When the caller handed the prepared input to its worker. */
  @syncing accessor acceptedAt: number | null = null;
  @syncing accessor contributionPluginName: string = "";
  @syncing accessor contributionBotName: string = "";
  @syncing accessor contributionRevision: string = "";
  @syncing private accessor diagnosticJson: string | null = null;
  @syncing.child accessor delivery: CallDelivery | null = null;

  constructor(props?: BotCallJobProps | symbol) {
    super(props);
  }

  override get kind(): JobKind {
    return "bot";
  }

  @computed
  get preparedInput(): unknown {
    return parseOutcomeValue(this.preparedInputJson);
  }

  /** A prepare document is stored. A null cell is no document. */
  @computed
  get preparedDocument(): boolean {
    return this.preparedInputJson != null;
  }

  @computed
  get diagnostic(): ReadonlyDeep<CallDiagnostic> | null {
    const rec = frozenRecord(this.diagnosticJson);
    if (rec == null) return null;
    const { code, message, attempts, recordedAt } = rec;
    if (typeof code !== "string" || typeof message !== "string") return null;
    if (typeof attempts !== "number" || typeof recordedAt !== "number") return null;
    return deepFreeze({ code, message, attempts, recordedAt });
  }

  /** Pin a contribution once; subsequent registry changes cannot retarget the call. */
  @syncing.action
  stampContribution(plugin: string, botName: string, revision: string): void {
    if (this.contributionPluginName !== "" || revision === "" || plugin === "") return;
    this.contributionPluginName = plugin;
    this.contributionBotName = botName;
    this.contributionRevision = revision;
  }

  @syncing.action
  acceptPreparedInput(prepared: unknown, workerSessionId: string): boolean {
    if (this.completed) return false;
    this.preparedInputJson = stringifyOutcomeValue(prepared);
    this.workerSessionId = workerSessionId;
    this.acceptedAt = Date.now();
    return true;
  }

  @syncing.action
  recordDiagnostic(code: string, message: string, attempts: number): void {
    this.diagnosticJson = JSON.stringify({ code, message, attempts, recordedAt: Date.now() });
  }
}
