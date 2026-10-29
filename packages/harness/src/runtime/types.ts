/**
 * Occupancy/policy facts plus admitted-call grants. Composition decides
 * seats; this package only derives eligibility from those inputs.
 */

/** Admitted, unsettled caller → worker edge. Never a fabricated client seat. */
export type DelegatedGrant = {
  readonly callId: string;
  readonly callerSessionId: string;
  readonly workerSessionId: string;
};

export type EligibilitySnapshot = {
  readonly acquired: ReadonlySet<string>;
  readonly occupied: ReadonlySet<string>;
  readonly resident: ReadonlySet<string>;
  /** Mint-until-first-seat. Idle conversations stay rooted; workers do not. */
  readonly reserved: ReadonlySet<string>;
  readonly conversations: ReadonlySet<string>;
  readonly grants: readonly DelegatedGrant[];
};
