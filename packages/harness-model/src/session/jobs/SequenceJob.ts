/**
 * Sequence bag. Approval cursor over coverable Approvable leaves.
 * Not collectors. Not `.work`.
 */
import { syncing } from "@here.build/plexus";
import { Job } from "@inhuman.tools/plexus-expectations";
import { computed } from "mobx";

import { ApprovableJob } from "./ApprovableJob.js";

@syncing("harness:job:sequence")
export abstract class SequenceJob<TValue = unknown, TReason = unknown> extends Job<TValue, TReason> {
  @computed
  get approvalLeaves(): ApprovableJob[] {
    const out: ApprovableJob[] = [];
    for (const child of this.children) {
      if (!(child instanceof Job)) continue;
      if (child instanceof ApprovableJob) {
        if (child.needsHuman) out.push(child);
        continue;
      }
      if (child instanceof SequenceJob) out.push(...child.approvalLeaves);
    }
    return out;
  }

  @computed
  get approvalHead(): ApprovableJob | null {
    for (const child of this.children) {
      if (!(child instanceof Job)) continue;
      if (child instanceof ApprovableJob) {
        if (child.needsHuman) return child;
        continue;
      }
      if (child instanceof SequenceJob) {
        const head = child.approvalHead;
        if (head != null) return head;
      }
    }
    return null;
  }
}
