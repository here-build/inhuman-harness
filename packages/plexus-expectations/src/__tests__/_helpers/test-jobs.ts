import { Plexus, syncing } from "@here.build/plexus";

import {
  Job,
  WorkContainer,
  WorkExpectation,
  type JobEffectOwner,
  type UnknownOutcomeRecovery,
} from "../../shared/index.js";

/** Tests that need a Job executor register StoredJob themselves. */
@syncing("test:ContractJob")
export class ContractJob<TValue = unknown, TReason = unknown> extends Job<TValue, TReason> {
  override readonly owner: JobEffectOwner = "session-runtime";
  override readonly intent: string = "";
  override readonly checkpoint: string = "";
  override readonly dispatch: string = "";
  override readonly settlement: string = "";
  override readonly cancel: string = "";
  override readonly unknownRecovery: UnknownOutcomeRecovery = "resume-queued";
  override readonly unknownNote: string = "";
  override readonly intentRequired: boolean = false;
}

@syncing("test:StoredJob")
export class StoredJob extends ContractJob {}

@syncing("test:PewJudge")
export class PewJudge extends WorkExpectation {}

@syncing("test:JobsSessionRoot")
export class JobsSessionRoot extends WorkContainer {
  @syncing.child.list accessor declared: Job[] = [];

  get work(): readonly WorkContainer[] {
    return this.declared;
  }
}

export function homeJobs(...jobs: Job[]): Disposable & { readonly root: JobsSessionRoot } {
  const root = new JobsSessionRoot();
  const plexus = Plexus.bootstrap(root);
  for (const job of jobs) root.declared.push(job);
  return {
    root,
    [Symbol.dispose]() {
      plexus.destroy();
    },
  };
}
