/**
 * Worker yield. Same mint ownership as {@link AgentCallbackJob}; appends
 * on the Call and does not complete it.
 */
import { syncing } from "@here.build/plexus";
import { type JobEffectOwner, type UnknownOutcomeRecovery } from "@inhuman.tools/plexus-expectations";
import { computed } from "mobx";

import { ToolCallJob } from "./ToolCallJob.js";

@syncing("harness:job:agent-notify")
export class AgentNotifyJob extends ToolCallJob {
  override readonly owner: JobEffectOwner = "agent-calls";
  override readonly intent: string =
    "Appending Call.notifications is a document write. Await a durable receipt covering the append intent, or treat a crash as unknown (do not append again).";
  override readonly checkpoint: string = "caller Call.notifications prefix on the caller session document.";
  override readonly dispatch: string = "push AgentCallNotification onto the Call. Does not complete the Call.";
  override readonly settlement: string = "notify job outcomeJson + completed.";
  override readonly cancel: string = "No-op if the Call is missing or notify is unsupported.";
  override readonly unknownRecovery: UnknownOutcomeRecovery = "unknown-no-replay";
  override readonly unknownNote: string = "A duplicate notify would hide whether the first append landed.";
  override readonly intentRequired: boolean = true;

  @computed
  override get commFirst(): boolean {
    return true;
  }
}
