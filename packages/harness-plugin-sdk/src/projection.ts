/**
 * Trajectory projection ABI. The host runs each pack `reduce` over plugin
 * metadata on the session graph. Hooks read the head projection and stamp the wire.
 * This package does not import the session document.
 */

export type PluginProjection<S = unknown, A = unknown> = {
  readonly initial: () => S;
  readonly reduce: (state: S, action: A) => S;
  /** Model-proposed metadata that may only be written sealed by the host. */
  readonly hostOnly?: (action: A) => boolean;
};

/** Prefix projection at this invocation. `propose` is the action, not the next state. */
export type PluginStorageHandles<S = unknown, A = unknown> = {
  readonly session: S;
  readonly invocation: S;
  readonly project?: S;
  readonly global?: S;
  propose(action: A): void;
};

/** Host-computed exam result. Pack `settle` turns this into metadata. */
export type ExamVerdict = {
  readonly ok: boolean;
  readonly comments: string;
};

/**
 * Frozen exam admit. Host copies `program` into a ProgrammaticJob and
 * seals `admit` onto that node. Model `expr` is ignored. `settle` is
 * the sealed close — host does not know the pack's verdict action.
 */
export type ExamAdmit<TIn = unknown, S = unknown, A = unknown> = {
  readonly program: (state: S, input: TIn) => string | { readonly error: string };
  readonly admit: (state: S, input: TIn) => A;
  readonly settle?: (state: S, input: TIn, result: ExamVerdict) => A;
};
