/**
 * Worker return. Completes when kernel has written the Call. Mints only
 * if this session has an open `agentCallbacks` row for the requestId.
 */
import { syncing } from "@here.build/plexus";
import { type JobEffectOwner, type UnknownOutcomeRecovery } from "@inhuman.tools/plexus-expectations";
import { computed } from "mobx";

import { ToolCallJob } from "./ToolCallJob.js";

@syncing("harness:job:agent-callback")
export class AgentCallbackJob extends ToolCallJob {
  override readonly owner: JobEffectOwner = "agent-calls";
  override readonly intent: string =
    "Settling the caller Call is the effect. Record intent and await a caller-document receipt before treating settle as done.";
  override readonly checkpoint: string =
    "caller session document prefix covering Call.outcome. Worker callback outcomeJson is a local receipt.";
  override readonly dispatch: string =
    "settleCallFromCallback, then persist a barrier on the caller document. Do not settle twice.";
  override readonly settlement: string = "caller outcome + callback outcomeJson + removeAgentCallback + completed.";
  override readonly cancel: string = "If the Call is already completed, finish the callback without a second settle.";
  override readonly unknownRecovery: UnknownOutcomeRecovery = "unknown-no-replay";
  override readonly unknownNote: string =
    "Unknown caller settle is not retried. A durable caller outcome completes the callback without re-settling.";
  override readonly intentRequired: boolean = true;

  @computed
  override get commFirst(): boolean {
    return true;
  }
}
