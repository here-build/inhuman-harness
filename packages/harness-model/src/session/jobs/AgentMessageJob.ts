/**
 * A2A send (name or id). Completes when the target turn is written.
 * No `agentCallbacks` row. Not a DAG edge.
 */
import { syncing } from "@here.build/plexus";
import { type JobEffectOwner, type UnknownOutcomeRecovery } from "@inhuman.tools/plexus-expectations";
import { computed } from "mobx";

import { ToolCallJob } from "./ToolCallJob.js";

@syncing("harness:job:agent-message")
export class AgentMessageJob extends ToolCallJob {
  override readonly owner: JobEffectOwner = "agent-calls";
  override readonly intent: string =
    "Minting an inbound SessionTurn on the target is non-idempotent. Record intent (target id, message, job identity) and await a receipt before writing the target head.";
  override readonly checkpoint: string =
    "target session document prefix covering the inbound turn. Worker outcomeJson is local settlement.";
  override readonly dispatch: string = "attachSession and write inbound SessionTurn as head.";
  override readonly settlement: string = "outcomeJson + completed on the message job.";
  override readonly cancel: string =
    "Abort before the target write. After the write, cancel does not unmint the inbound turn.";
  override readonly unknownRecovery: UnknownOutcomeRecovery = "unknown-no-replay";
  override readonly unknownNote: string =
    "Unknown target write is not retried. Do not mint a second inbound turn for the same job.";
  override readonly intentRequired: boolean = true;

  @computed
  override get commFirst(): boolean {
    return true;
  }
}
