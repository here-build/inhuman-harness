import { DocumentContainer, Model, model, state } from "@inhuman.tools/model";
import { runInAction } from "mobx";

import type { DriverConnectionClass } from "../../driver/ExpectationDriver.js";
import { Orchestrator } from "../../executor/orchestrator.js";
import {
  ConnectionSpec,
  DriverSpec,
  Job,
  WorkContainer,
  WorkExpectation,
  type KernelDocument,
  type KernelRootModel,
  type SessionDocument,
} from "../../shared/index.js";

@model("test:JobsKernelRoot")
export class JobsKernelRoot extends Model implements KernelRootModel {
  @state.childRecord accessor connections: Record<string, ConnectionSpec> = {};
  @state.childRecord accessor drivers: Record<string, DriverSpec> = {};
}

/** Widened so a WorkExpectation sibling can sit on `.work` without being a Job. */
@model("test:JobsOrchRoot")
export class JobsOrchRoot extends WorkContainer {
  @state.childList accessor declared: Array<Job | WorkExpectation> = [];

  get work(): readonly WorkContainer[] {
    return this.declared;
  }
}

/** Abstract hooks only. No pre-registered Job executor. */
export class TestJobOrchestrator extends Orchestrator {
  async loadDriverModule(): Promise<DriverConnectionClass> {
    throw new Error("loadDriverModule must not run in these tests");
  }
}

function bootstrapSession(): {
  readonly kernel: KernelDocument;
  readonly session: SessionDocument;
  readonly sessionRoot: JobsOrchRoot;
} {
  const kernelRoot = new JobsKernelRoot();
  const sessionRoot = new JobsOrchRoot();
  const kernel = new DocumentContainer(kernelRoot) as KernelDocument;
  const session = new DocumentContainer(sessionRoot) as SessionDocument;
  return { kernel, session, sessionRoot };
}

export function makeJobHost(
  seed: Array<Job | WorkExpectation> = [],
  opts?: { readonly activate?: boolean },
): Disposable & {
  readonly host: TestJobOrchestrator;
  readonly sessionRoot: JobsOrchRoot;
} {
  const { kernel, session, sessionRoot } = bootstrapSession();
  sessionRoot.declared.push(...seed);
  const host = new TestJobOrchestrator(kernel, session);
  if (opts?.activate !== false) host.activate();
  return {
    host,
    get sessionRoot() {
      return new Proxy(sessionRoot, {
        get(target, prop, receiver) {
          if (prop === "declared") {
            const arr = target.declared;
            return new Proxy(arr, {
              get(aTarget, aProp, aReceiver) {
                if (aProp === "push" || aProp === "splice") {
                  return (...items: any[]) =>
                    runInAction(() => (aTarget as any)[aProp](...items));
                }
                return Reflect.get(aTarget, aProp, aReceiver);
              },
            });
          }
          return Reflect.get(target, prop, receiver);
        },
      });
    },
    [Symbol.dispose]() {
      host[Symbol.dispose]();
      kernel.destroy();
      session.destroy();
    },
  };
}
