import { Plexus, PlexusModel, syncing } from "@here.build/plexus";

import type { DriverConnectionClass } from "../../driver/PEWDriver.js";
import { Orchestrator } from "../../executor/orchestrator.js";
import {
  ConnectionSpec,
  DriverSpec,
  Job,
  WorkContainer,
  WorkExpectation,
  type KernelPlexus,
  type KernelRootModel,
  type SessionPlexus,
} from "../../shared/index.js";

@syncing("test:JobsKernelRoot")
export class JobsKernelRoot extends PlexusModel<null> implements KernelRootModel {
  @syncing.child.record accessor connections: Record<string, ConnectionSpec> = {};
  @syncing.child.record accessor drivers: Record<string, DriverSpec> = {};
}

/** Widened so a PEW sibling can sit on `.work` without being a Job. */
@syncing("test:JobsOrchRoot")
export class JobsOrchRoot extends WorkContainer {
  @syncing.child.list accessor declared: Array<Job | WorkExpectation> = [];

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
  readonly kernel: KernelPlexus;
  readonly session: SessionPlexus;
  readonly sessionRoot: JobsOrchRoot;
} {
  const kernelRoot = new JobsKernelRoot();
  const sessionRoot = new JobsOrchRoot();
  const kernel = Plexus.bootstrap(kernelRoot) as KernelPlexus;
  const session = Plexus.bootstrap(sessionRoot) as SessionPlexus;
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
    sessionRoot,
    [Symbol.dispose]() {
      host[Symbol.dispose]();
      kernel.destroy();
      session.destroy();
    },
  };
}
