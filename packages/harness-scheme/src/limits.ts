/**
 * scheme_repl / scheme_watch bounds. Time and inner-call budgets are
 * opt-in: omit `timeoutMs` / `maxInternalCalls` for no limit. Eval-turn
 * uses the same contract — no host ceiling.
 */
export interface SchemeReplLimits {
  /** Binary content blocks kept from one inner tool result. */
  readonly maxAttachments: number;
}

export const DEFAULT_SCHEME_REPL_LIMITS: SchemeReplLimits = Object.freeze({
  maxAttachments: 4,
});
