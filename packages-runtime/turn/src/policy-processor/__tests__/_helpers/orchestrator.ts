/**
 * Test orchestrator: real Job claim, license as the guard.
 * Programs are stamped on the session root before enqueue.
 */
import { Plexus, resetLocalIDs } from "@here.build/plexus";
import { prompt } from "@inhuman.tools/harness-commons";
import {
  KernelPlexus,
  KernelRoot,
  SessionRoot,
  SessionSystemPrompt,
  SessionTurn,
  SessionTurnEvalSpec,
  ToolCallJob,
  isEvalPermissionMode,
  type CompletionExpectation,
  type GrantRow,
  type PermissionMode,
  type TurnChunk,
} from "@inhuman.tools/harness-model";
import type { DriverConnectionClass } from "@inhuman.tools/plexus-expectations/driver";
import { Orchestrator } from "@inhuman.tools/plexus-expectations/executor";
import { reaction, runInAction, type IReactionDisposer } from "mobx";

import { childCompletions, completedAssistant, sealedObservation } from "./jobs.js";
import { license } from "../../license.js";
import { scopes } from "../../scope.js";

export class TestLicenseOrchestrator extends Orchestrator {
  async loadDriverModule(): Promise<DriverConnectionClass> {
    throw new Error("loadDriverModule must not run in these tests");
  }
}

const DIST_ASK = ";; stub\n";

export function setup(opts: {
  readonly policy?: PermissionMode;
  /** Session root path. Default is a stub that does not exist. */
  readonly path?: string;
  readonly policyProgram?: string;
  readonly judgeAskProgram?: string;
  readonly cap?: number;
  readonly backoffMs?: (n: number) => number;
  readonly judgeDeadlineMs?: (attempt: number) => number;
  readonly privileged?: string;
  readonly unattended?: boolean;
  readonly priorTurn?: string;
  readonly quarantined?: string;
  readonly seal?: (completion: CompletionExpectation) => void;
  /** Most tests isolate the matcher/judge; dedicated Tirith cases exercise the installed binary. */
  readonly realShellCheck?: boolean;
  /** The user layer of the authorization table (`config.json` `authorization`). */
  readonly user?: unknown;
  /** The project layer (tighten only), as the file's text. */
  readonly project?: string;
  /** Session read roots ("Treat <folder> as part of this session?"). */
  readonly readRoots?: readonly string[];
  /** Stored grants visible to the session (session-scope rows ride the root). */
  readonly grants?: readonly GrantRow[];
  /** Earlier user prompts, oldest first, in front of the turn's own prompt. */
  readonly earlier?: readonly { readonly user: string; readonly assistant?: string }[];
}): {
  readonly root: SessionRoot;
  readonly turn: SessionTurn;
  readonly host: TestLicenseOrchestrator;
  enqueue(job: ToolCallJob): void;
  [Symbol.dispose](): void;
} {
  resetLocalIDs();
  const kernel = KernelPlexus.bootstrap(new KernelRoot());
  const root = new SessionRoot({
    sessionId: "s-lic",
    path: opts.path ?? "/tmp/lic",
    standingPermissionMode: opts.policy ?? "manual",
    policyProgram: opts.policyProgram ?? "",
    judgeAskProgram: opts.judgeAskProgram ?? DIST_ASK,
    authorizationUserJson: opts.user === undefined ? "" : JSON.stringify(opts.user),
    authorizationProjectJson: opts.project ?? "",
    grantsJson: opts.grants === undefined ? "" : JSON.stringify(opts.grants),
    readRoots: Object.fromEntries((opts.readRoots ?? []).map((path) => [path, "session"])),
  });
  const session = Plexus.bootstrap(root);
  const doneWork: TurnChunk[] = [];
  if (opts.priorTurn !== undefined && opts.priorTurn !== "") doneWork.push(completedAssistant(opts.priorTurn));
  if (opts.quarantined !== undefined && opts.quarantined !== "") doneWork.push(sealedObservation(opts.quarantined));
  let tail: SessionTurn | SessionSystemPrompt = new SessionSystemPrompt();
  for (const earlier of opts.earlier ?? []) {
    tail = new SessionTurn({
      turnTail: tail,
      prompt: prompt.user`${earlier.user}`,
      queue: [],
      doneWork: earlier.assistant === undefined ? [] : [completedAssistant(earlier.assistant)],
      reducerExited: true,
    });
  }
  const turn = new SessionTurn({
    turnTail: tail,
    prompt: prompt.user`${opts.privileged ?? ""}`,
    queue: [],
    doneWork,
    evalSpec:
      (opts.unattended ?? opts.policy === "auto")
        ? new SessionTurnEvalSpec({
            requestId: "req-u",
            permissionMode: opts.policy !== undefined && isEvalPermissionMode(opts.policy) ? opts.policy : "auto",
          })
        : null,
    permissionMode: opts.policy,
  });
  root.head = turn;
  const scope = scopes.get(root);
  if (!opts.realShellCheck) scope.checkShell = async () => ({ action: "allow", findings: [] });
  if (opts.cap !== undefined) {
    runInAction(() => {
      scope.cap = opts.cap!;
    });
  }
  if (opts.backoffMs !== undefined) scope.backoffMs = opts.backoffMs;
  if (opts.judgeDeadlineMs !== undefined) scope.judgeDeadlineMs = opts.judgeDeadlineMs;
  const host = new TestLicenseOrchestrator(kernel, session);
  host.registerExecutor(
    ToolCallJob,
    (job) => license(job, turn, root),
    async () => {},
  );
  host.activate();
  const stops: IReactionDisposer[] = [];
  if (opts.seal !== undefined) {
    const seal = opts.seal;
    stops.push(
      reaction(
        () => [...scope.waiting].flatMap((job) => childCompletions(job).filter((child) => child.outcome == null)),
        (open) => {
          for (const completion of open) seal(completion);
        },
        { fireImmediately: true },
      ),
    );
  }
  return {
    root,
    turn,
    host,
    enqueue(job: ToolCallJob) {
      turn.enqueue(job);
    },
    [Symbol.dispose]() {
      for (const stop of stops) stop();
      host[Symbol.dispose]();
      scope.close();
      kernel.destroy();
      session.destroy();
    },
  };
}
