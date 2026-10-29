import type { EnvCapability } from "@here.build/arrival";
import type { EvalTrace } from "@here.build/arrival/provenance";
import type { AgentCallNotification, ApprovableJob, ProgrammaticJob } from "@inhuman.tools/harness-model";
import type { BoundTool } from "@inhuman.tools/substrate/bound-tool";
import type { DoorSession } from "@inhuman.tools/substrate/doors";

export type PreparedProgram = {
  readonly capabilities: readonly EnvCapability[];
  readonly config: object;
};

/**
 * What the interpreter needs from an engine. Catalog, secrets, and tool bodies
 * stay in the capabilities `prepare` returns. This package does not look them up.
 */
export type ProgramHost = {
  /** Stable across wrappers. The runtime map keys on this, not on the wrapper. */
  readonly identity: object;
  readonly signal?: AbortSignal;
  readonly doors: DoorSession;
  readonly root: string;
  readonly abort?: (leaf: ApprovableJob, reason?: unknown) => void;
  readonly notify?: (note: AgentCallNotification) => void;
  readonly evalProgram?: boolean;
  readonly moduleRoot?: string;
  /**
   * Wraps one run of the program (the whole one-shot, or one period tick) so the host owns its trace.
   * The host mints the trace, arms what it reads, and reads it as the run goes; when `run` settles, the run is over.
   */
  readonly observe?: <T>(run: (trace: EvalTrace) => Promise<T>) => Promise<T>;
  /** Unbound-variable door. Called per evaluation; `prepare` snapshots tools onto config separately. */
  readonly tools: () => ReadonlyMap<string, BoundTool>;
  /** Engine vocabulary. The interpreter appends display. The watchdog wraps this to append meta-reactivity. */
  readonly prepare: (opts: {
    readonly moduleRoot: string | undefined;
    readonly job: ProgrammaticJob;
  }) => PreparedProgram;
  /** Read recorded children. Do not mint, do not append notes, do not seal the job. */
  readonly replayOnly?: boolean;
};

export type ProgramRuntime = {
  arm(opts: {
    readonly moduleRoot: string | undefined;
    /** Accepted so existing arm calls typecheck. The watchdog roots meta-reactivity by wrapping prepare. */
    readonly watching?: boolean;
  }): void;
  beginTick(tick: {
    readonly signal: AbortSignal;
    readonly origin: number;
    readonly maxInternalCalls: number | undefined;
  }): void;
  clearFailure(): void;
  failureCode(): string | undefined;
  readonly capabilities: readonly EnvCapability[];
  readonly config: object;
};
