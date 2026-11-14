import { DocumentContainer, model, state } from "@inhuman.tools/model";

import {
  Job,
  WorkContainer,
  WorkExpectation,
  type JobEffectOwner,
  type UnknownOutcomeRecovery,
} from "../../shared/index.js";

/** Tests that need a Job executor register StoredJob themselves. */
@model("test:ContractJob")
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

@model("test:StoredJob")
export class StoredJob extends ContractJob {}

@model("test:TestJudge")
export class TestJudge extends WorkExpectation {}

@model("test:JobsSessionRoot")
export class JobsSessionRoot extends WorkContainer {
  @state.childList accessor declared: Job[] = [];

  get work(): readonly WorkContainer[] {
    return this.declared;
  }
}

export function homeJobs(...jobs: Job[]): Disposable & { readonly root: JobsSessionRoot; readonly container: DocumentContainer<JobsSessionRoot> } {
  const root = new JobsSessionRoot();
  const container = new DocumentContainer(root);
  for (const job of jobs) root.declared.push(job);
  return {
    root,
    container,
    [Symbol.dispose]() {
      container.destroy();
    },
  };
}
