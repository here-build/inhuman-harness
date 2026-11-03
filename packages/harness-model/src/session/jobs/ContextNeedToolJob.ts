/** Legacy serialized context calls use the normal system-tool executor. New calls are SystemToolJobs. */
import { syncing } from "@here.build/plexus";
import { type JobEffectOwner, type UnknownOutcomeRecovery } from "@inhuman.tools/plexus-expectations";
import { computed } from "mobx";

import { SystemToolJob } from "./SystemToolJob.js";
import { contextNeedAdmitSchema } from "../../schemas/context-need.js";
import type { ContextNeed } from "../context-need.js";

@syncing("harness:job:context-need")
export class ContextNeedToolJob extends SystemToolJob {
  override readonly owner: JobEffectOwner = "tool-runtime";
  override readonly intent: string = "Resume the legacy context request through the catalog tool body.";
  override readonly checkpoint: string = "argsJson on the job. No external effect.";
  override readonly dispatch: string = "Execute the context tool body and commit its action and receipt.";
  override readonly settlement: string = "outcomeJson + completed.";
  override readonly cancel: string = "Deny/cancel receipt without stamping a successful need.";
  override readonly unknownRecovery: UnknownOutcomeRecovery = "resume-queued";
  override readonly unknownNote: string =
    "Safe to resume through the catalog body; the context request has no external side effect.";
  override readonly intentRequired: boolean = false;

  @computed
  get need(): ContextNeed | null {
    if (this.outcomeSnap?.ok !== true) return null;
    const parsed = contextNeedAdmitSchema.safeParse(this.args);
    return parsed.success ? parsed.data : null;
  }
}
