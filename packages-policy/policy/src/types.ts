/**
 * Floor carriers. `policyApprove` is the positive vote. Stored `approve` and `allow` parse as it.
 * `block` is unliftable. `deny` is overridable by descending arms.
 * File effects (`read_path` / `write_path`) join on their own lattice, apart from bash
 * shape — they cannot lift `ask`.
 */

import type { ClassId } from "./classes.js";

export type Disposition = "policyApprove" | "ask" | "deny" | "block";

/** Write-deny remainder intern. Null when the floor is not deny. */
export type WriteRemainderKind = "protected" | "outside" | "risky";

export type ArgType = "read_path" | "write_path";

/** Why an approve became ask without a rule saying so. A lifted vote is never grantable. */
export type LiftKind = "env" | "xargs" | "nonliteral" | "unparsed" | "overflow" | "readings";

/** Grant family of one shell unit: program, recognized subcommand spine, `family_args` positionals. */
export type UnitIdentity = {
  readonly argv0: string;
  readonly spine: readonly string[];
  readonly familyArgs: readonly string[];
};

/** One rule's vote, with the class that says why it voted. Only votes at the call's tier are reported. */
export type FloorVote = {
  readonly disposition: Disposition;
  readonly class: ClassId;
  /** Stable rule identity: `bash:git/push[--force]`, `write_block:.git/hooks`, `lift:env`. */
  readonly ruleId: string;
  /** Shell votes only: the unit that voted. Absent for path and host votes. */
  readonly unit?: UnitIdentity;
  readonly lift?: LiftKind;
  /** Path votes only: the prepared path and the cluster it was judged in. */
  readonly path?: { readonly cluster: "read" | "write"; readonly path: string };
};

/** The tier and the votes that decided it. `votes` is empty for `policyApprove`. */
export type FloorVerdict = {
  readonly disposition: Disposition;
  readonly votes: readonly FloorVote[];
  /**
   * Every shell unit the call runs, at any tier (an approve names none in `votes`). Only a shell verdict
   * has it. An acknowledgement flag on a command family needs it to see an approved call.
   */
  readonly seen?: readonly UnitIdentity[];
};

export type Policy = {
  /** `cwd`: workspace-relative directory the shell runs in; relative path words re-base on it. */
  readonly bash: (command: string, cwd?: string) => Disposition;
  readonly explainBash: (command: string, cwd?: string) => FloorVerdict;
  readonly read: (path: string) => Disposition;
  readonly explainRead: (path: string) => FloorVerdict;
  readonly write: (path: string) => Disposition;
  readonly explainWrite: (path: string) => FloorVerdict;
  /** Write-deny remainder intern. Null when the floor is not deny. */
  readonly writeKind: (path: string) => WriteRemainderKind | null;
};

export type FlagConstraint = {
  readonly names: readonly string[];
  readonly vals: readonly string[];
  readonly takesValue: boolean;
};

export type Matcher = {
  readonly class?: ClassId;
  readonly flags: Readonly<Record<string, FlagConstraint>>;
  readonly globs: readonly string[];
  readonly toks: readonly string[];
  readonly matchers: readonly Matcher[];
  readonly policy?: Disposition;
};

export type CommandNode = {
  readonly policy?: Disposition;
  /** Why this node votes what it votes. Inherited from the nearest ancestor that names one. */
  readonly class?: ClassId;
  /** Leading positionals (after the spine) that belong to the grant family. Does not affect the tier. */
  readonly familyArgs: number;
  readonly argTypes: readonly ArgType[];
  readonly argRestType?: ArgType;
  readonly matchers: readonly Matcher[];
  /** Option whose value is a path (`--output=F`, glued `-oF`). Long names carry their prefixes. */
  readonly flagPaths: Readonly<Record<string, ArgType>>;
  /** Named argument guards (see guards.ts) for what flags and positionals cannot express. */
  readonly guards: readonly string[];
  readonly dash?: CommandNode;
  readonly subcommands: Readonly<Record<string, CommandNode>>;
};

/** Classes of the votes that decided the tier. A tier with no voting rule is `unmodelled`. */
export function classesOf(verdict: FloorVerdict): readonly ClassId[] {
  if (verdict.disposition === "policyApprove") return [];
  const classes = new Set(
    verdict.votes.filter((vote) => vote.disposition === verdict.disposition).map((vote) => vote.class),
  );
  return classes.size === 0 ? ["unmodelled"] : [...classes];
}
