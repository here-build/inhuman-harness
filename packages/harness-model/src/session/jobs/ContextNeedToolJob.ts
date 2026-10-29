/**
 * Model-authored context expectation. Operands live in `args`.
 * Host derives `SessionTurn.contextNeed` from this class, never from the wire name.
 */
import { syncing } from "@here.build/plexus";
import { type JobEffectOwner, type UnknownOutcomeRecovery } from "@inhuman.tools/plexus-expectations";
import { computed } from "mobx";

import { ToolCallJob } from "./ToolCallJob.js";
import { contextNeedAdmitSchema } from "../../schemas/context-need.js";
import type { ContextNeed } from "../context-need.js";

@syncing("harness:job:context-need")
export class ContextNeedToolJob extends ToolCallJob {
  override readonly owner: JobEffectOwner = "tool-runtime";
  override readonly intent: string =
    "None. After license, stamp ok. Host derives SessionTurn.contextNeed from this class.";
  override readonly checkpoint: string = "argsJson on the job. No external effect.";
  override readonly dispatch: string = "Stamp outcomeJson ok. No network, no filesystem.";
  override readonly settlement: string = "outcomeJson + completed.";
  override readonly cancel: string = "Deny/cancel receipt without stamping a successful need.";
  override readonly unknownRecovery: UnknownOutcomeRecovery = "resume-queued";
  override readonly unknownNote: string = "Safe to re-run the stamp. No external side effect.";
  override readonly intentRequired: boolean = false;

  @computed
  get need(): ContextNeed | null {
    const parsed = contextNeedAdmitSchema.safeParse(this.args);
    return parsed.success ? parsed.data : null;
  }
}
