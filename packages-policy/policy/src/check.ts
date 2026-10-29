/**
 * String processors over a compiled YAML term. Prep, unparsed→ask, empty I→ask,
 * and the pipeline lattice live here — not on the host.
 *
 * Shape (policy / matcher / subcommands) is one vote. File effects from
 * arg_types / arg_rest_type join on their own lattice — they cannot lift ask.
 * `"--"` present: suffix is re-parsed with that body's flag vocabulary
 * (undeclared dash tokens stay positionals). `"--"` absent: cutoff, consume
 * the delimiter, leftovers are positionals.
 *
 * Every vote carries the class of the rule that cast it (see classes.ts). The verdict of a call
 * is the strictest disposition plus the votes at exactly that disposition (verdict.ts `join`).
 */

import { partition, prep } from "@inhuman.tools/policy-bash-disassembler";
import { minimatch, type MinimatchOptions } from "minimatch";

import type { ClassId } from "./classes.js";
import { flagVocab, valueFlagNames } from "./compile.js";
import { guardVotes, pathVote } from "./guards.js";
import { identityName, type Which } from "./identity.js";
import { type PathTerm } from "./path-policy.js";
import type {
  ArgType,
  CommandNode,
  Disposition,
  FlagConstraint,
  FloorVerdict,
  LiftKind,
  Matcher,
  UnitIdentity,
} from "./types.js";
import { APPROVE, cast, join, withUnit } from "./verdict.js";

type PathClusters = {
  readonly read?: PathTerm;
  readonly write?: PathTerm;
  /** Workspace-relative (or extra-root absolute) directory the shell runs in. Relative path tokens re-base on it. */
  readonly cwd?: string;
  /** The shell would expand this question's words (an argument is not literal). */
  readonly expand?: boolean;
  /** `dotglob` is mentioned in the command: `*` may match a leading dot. */
  readonly dotglob?: boolean;
};

/**
 * Variables that cannot name a program, library, config file, or search path.
 * Everything else in an env-assignment prefix lifts approve to ask.
 */
const INERT_ENV = new Set([
  "LANG",
  "LANGUAGE",
  "TZ",
  "NO_COLOR",
  "FORCE_COLOR",
  "CLICOLOR",
  "CLICOLOR_FORCE",
  "TERM",
  "CI",
]);

function inertEnvName(name: string): boolean {
  return INERT_ENV.has(name) || /^LC_[A-Z]+$/.test(name);
}

/** What the floor cannot see through: env vars, stdin-appended args, expansions. Only lifts approve. */
function blindSpot(question: {
  readonly envDelta: Readonly<Record<string, string>>;
  readonly wrapChain: readonly string[];
  readonly nonLiteral: boolean;
}): LiftKind | undefined {
  if (question.nonLiteral) return "nonliteral";
  if (question.wrapChain.includes("xargs")) return "xargs";
  if (Object.keys(question.envDelta).some((name) => !inertEnvName(name))) return "env";
  return undefined;
}

const CUT = "--";
/** A command whose rules name no class (the dist root names one; a user document may not). */
const ROOT_CLASS: ClassId = "exec-unknown";

type Ctx = {
  readonly toks: readonly string[];
  readonly flags: Readonly<Record<string, readonly string[]>>;
  readonly cutConsumed: boolean;
};

/** What a node hands its children: the tier it votes by default, the class it votes as, and where it is. */
type Inherited = { readonly policy: Disposition; readonly cls: ClassId; readonly id: string };

export function checkBash(
  term: CommandNode,
  command: string,
  clusters: PathClusters = {},
  which?: Which,
  cwd?: string,
): Disposition {
  return explainBash(term, command, clusters, which, cwd).disposition;
}

export function explainBash(
  term: CommandNode,
  command: string,
  clusters: PathClusters = {},
  which?: Which,
  cwd?: string,
): FloorVerdict {
  const base: PathClusters = cwd === undefined ? clusters : { ...clusters, cwd };
  const dotglob = /\bdotglob\b|\bGLOBIGNORE\b/.test(command);
  const names = new Set(Object.keys(term.subcommands));
  const prepared = prep(command, {
    which,
    valueFlagsFor: (argv0, suffix) => collectSpineValueFlags(term, identityName(argv0, names, which), suffix),
  });
  const seenUnits: UnitIdentity[] = [];
  const hits: FloorVerdict[] = prepared.questions.flatMap((question) => {
    const paths: PathClusters = { ...base, expand: question.nonLiteral, dotglob };
    const argv0 = identityName(question.argv0, names, which);
    const root = rootInherited(term);
    const floorToks = [argv0];
    const floor = evalCommand(
      term,
      { toks: floorToks, flags: {}, cutConsumed: false },
      walkSpine(term, floorToks, 0, false, {}),
      0,
      root,
      paths,
    );
    const votes = question.readings.map((reading) => {
      const toks = [argv0, ...reading.tokens];
      return evalCommand(
        term,
        { toks, flags: reading.flags, cutConsumed: false },
        walkSpine(term, toks, 0, false, {}),
        0,
        root,
        paths,
      );
    });
    const shaped = liftReadings(votes, question.overflow === true, floor);
    // A blind spot (env prefix, xargs, non-literal word) lifts an approve to ask, and marks an ask
    // a rule already cast: either way the floor cannot say what will run, so no grant covers it.
    const reason = blindSpot(question);
    const seen =
      reason === undefined || shaped.disposition === "deny" || shaped.disposition === "block"
        ? shaped
        : shaped.disposition === "policyApprove"
          ? lifted(reason)
          : markLifted(shaped, reason);
    const unit = unitOf(term, argv0, question.readings, names);
    if (unit !== undefined) seenUnits.push(unit);
    return [withUnit(seen, unit), ...redirVotes(question.redirects, { ...base, expand: true, dotglob })];
  });
  hits.push(...redirVotes(prepared.redirects, { ...base, expand: true, dotglob }));
  if (prepared.unparsed.length > 0) hits.push(lifted("unparsed"));
  const verdict = hits.length === 0 ? cast("ask", "unmodelled", "bash:empty") : join(hits);
  return seenUnits.length === 0 ? verdict : { ...verdict, seen: seenUnits };
}

function markLifted(verdict: FloorVerdict, reason: LiftKind): FloorVerdict {
  return { disposition: verdict.disposition, votes: verdict.votes.map((vote) => ({ lift: reason, ...vote })) };
}

/** `bash` → `bash:npm` → `bash:npm/publish`. */
function childId(parent: string, name: string): string {
  return parent === "bash" ? `bash:${name}` : `${parent}/${name}`;
}

function lifted(reason: LiftKind): FloorVerdict {
  return cast("ask", ROOT_CLASS, `lift:${reason}`, { lift: reason });
}

function rootInherited(term: CommandNode): Inherited {
  return { policy: term.policy ?? "ask", cls: term.class ?? ROOT_CLASS, id: "bash" };
}

/**
 * Grant family of a question: program, the recognized subcommand spine, and `family_args`
 * leading positionals. Readings that disagree (an ambiguous option parse) have no identity.
 */
function unitOf(
  term: CommandNode,
  argv0: string,
  readings: readonly { readonly tokens: readonly string[] }[],
  names: ReadonlySet<string>,
): UnitIdentity | undefined {
  const units = readings.map((reading) => unitOfReading(term, argv0, reading.tokens, names));
  const first = units[0];
  if (first === undefined) return { argv0, spine: [], familyArgs: [] };
  return units.every((unit) => JSON.stringify(unit) === JSON.stringify(first)) ? first : undefined;
}

function unitOfReading(
  term: CommandNode,
  argv0: string,
  tokens: readonly string[],
  names: ReadonlySet<string>,
): UnitIdentity {
  let node = names.has(argv0) ? commandChild(term, argv0) : undefined;
  const spine: string[] = [];
  let at = 0;
  while (node !== undefined) {
    const next = tokens[at];
    if (next === undefined || !isLeadingPositional(next)) break;
    const child = commandChild(node, next);
    if (child === undefined) break;
    spine.push(next);
    node = child;
    at += 1;
  }
  const arity = node?.familyArgs ?? 0;
  const familyArgs = tokens.slice(at).filter(isLeadingPositional).slice(0, arity);
  return { argv0, spine, familyArgs };
}

function collectSpineValueFlags(term: CommandNode, argv0: string, suffix: readonly string[]): Set<string> {
  const names = new Set<string>();
  addValueFlags(term, names);
  const child = commandChild(term, argv0);
  if (!child) return names;
  collectFromNode(child, suffix, 0, names);
  return names;
}

function collectFromNode(
  node: CommandNode,
  words: readonly string[],
  i: number,
  names: Set<string>,
  cutConsumed = false,
): void {
  addValueFlags(node, names);
  let at = i;
  let consumed = cutConsumed;
  if (tokenAt(words, at) === CUT && node.dash === undefined && !consumed) {
    at += 1;
    consumed = true;
  }
  if (tokenAt(words, at) === CUT && node.dash !== undefined) return;
  const next = tokenAt(words, at);
  if (next === undefined || !isLeadingPositional(next)) return;
  const child = commandChild(node, next);
  if (child) collectFromNode(child, words, at + 1, names, consumed);
}

function addValueFlags(node: CommandNode, names: Set<string>): void {
  for (const name of valueFlagNames(node)) names.add(name);
}

function isLeadingPositional(word: string): boolean {
  return word !== CUT && (word === "-" || !word.startsWith("-"));
}

function tokenAt(toks: readonly string[], i: number): string | undefined {
  return i >= 0 && i < toks.length ? toks[i] : undefined;
}

function commandChild(node: CommandNode, name: string | undefined): CommandNode | undefined {
  return name !== undefined && Object.hasOwn(node.subcommands, name) ? node.subcommands[name] : undefined;
}

/**
 * Readings of one command (an ambiguous option parse forks them). All agree: that vote. A disagreement
 * between approve, ask and deny is `ask`, and it is a lift: no rule asked, the parse is what is unsure.
 */
function liftReadings(evals: readonly FloorVerdict[], overflow: boolean, floor: FloorVerdict): FloorVerdict {
  const blocks = evals.filter((vote) => vote.disposition === "block");
  if (blocks.length > 0 || (overflow && floor.disposition === "block")) {
    return join([...blocks, ...(overflow ? [floor] : [])]);
  }
  if (overflow) return floor.disposition === "deny" ? floor : lifted("overflow");
  if (evals.length === 0) return lifted("readings");
  if (evals.every((vote) => vote.disposition === "deny")) return join(evals);
  if (evals.every((vote) => vote.disposition === "policyApprove")) return APPROVE;
  if (evals.every((vote) => vote.disposition === "ask")) return join(evals);
  return lifted("readings");
}

/** Node vote joined with the node's argument guards (guards.ts): they only tighten. */
function evalCommand(
  node: CommandNode,
  ctx: Ctx,
  bindings: Readonly<Record<string, number>>,
  depth: number,
  inherited: Inherited,
  paths: PathClusters,
): FloorVerdict {
  const vote = evalNode(node, ctx, bindings, depth, inherited, paths);
  const extra = guardVotes(node, ctx.toks, ctx.flags, paths);
  return extra.length === 0 ? vote : join([vote, ...extra]);
}

function evalNode(
  node: CommandNode,
  ctx: Ctx,
  bindings: Readonly<Record<string, number>>,
  depth: number,
  inherited: Inherited,
  paths: PathClusters,
): FloorVerdict {
  const policy = node.policy ?? inherited.policy;
  const cls = node.class ?? inherited.cls;
  const here = bindings;
  let toks = ctx.toks;
  let cutConsumed = ctx.cutConsumed;
  if (toks[0] === CUT && node.dash === undefined && !cutConsumed) {
    toks = toks.slice(1);
    cutConsumed = true;
  }
  const self: Inherited = { policy, cls, id: inherited.id };
  const own = cast(policy, cls, self.id);

  if (toks[0] === CUT && node.dash !== undefined) {
    const dashVote = evalDash(
      node.dash,
      toks.slice(1),
      here,
      depth + 1,
      { ...self, id: childId(self.id, "--") },
      paths,
    );
    const matcherHits = matcherVotes(node, toks, ctx.flags, here, depth, self);
    return shapeOf([...matcherHits, dashVote], own);
  }

  const next = tokenAt(toks, 0);
  const child = commandChild(node, next);
  const matcherHits = matcherVotes(node, toks, ctx.flags, here, depth, self);
  if (child) {
    const childVote = evalCommand(
      child,
      { toks: toks.slice(1), flags: ctx.flags, cutConsumed },
      here,
      depth + 1,
      { ...self, id: childId(self.id, next!) },
      paths,
    );
    return shapeOf([...matcherHits, childVote], own);
  }

  const files = fileVotes(node, stripCut(toks), paths);
  return join([shapeOf(matcherHits, own), ...files]);
}

function matcherVotes(
  node: CommandNode,
  toks: readonly string[],
  flags: Readonly<Record<string, readonly string[]>>,
  bindings: Readonly<Record<string, number>>,
  depth: number,
  self: Inherited,
): FloorVerdict[] {
  return node.matchers.flatMap((matcher) => {
    const vote = evalMatcher(matcher, toks, flags, bindings, depth, self);
    return vote === undefined ? [] : [vote];
  });
}

function evalDash(
  node: CommandNode,
  suffix: readonly string[],
  bindings: Readonly<Record<string, number>>,
  depth: number,
  inherited: Inherited,
  paths: PathClusters,
): FloorVerdict {
  const closed = flagVocab(node);
  const valueFlags = valueFlagNames(node);
  const { readings, overflow } = partition(suffix, valueFlags, closed);
  const floor = evalCommand(node, { toks: [], flags: {}, cutConsumed: true }, bindings, depth, inherited, paths);
  if (readings.length === 0) {
    return liftReadings(
      [evalCommand(node, { toks: suffix, flags: {}, cutConsumed: true }, bindings, depth, inherited, paths)],
      overflow,
      floor,
    );
  }
  const votes = readings.map((reading) =>
    evalCommand(
      node,
      { toks: reading.tokens, flags: reading.flags, cutConsumed: true },
      bindings,
      depth,
      inherited,
      paths,
    ),
  );
  return liftReadings(votes, overflow, floor);
}

/** Descending arms override the node's own vote; `block` on the node holds regardless. */
function shapeOf(hits: readonly FloorVerdict[], own: FloorVerdict): FloorVerdict {
  if (hits.length === 0) return own;
  if (own.disposition === "block") return own;
  return join(hits);
}

function walkSpine(
  node: CommandNode,
  toks: readonly string[],
  depth: number,
  cutConsumed: boolean,
  acc: Record<string, number>,
): Record<string, number> {
  for (const name of flagVocab(node)) acc[name] = Math.max(acc[name] ?? -1, depth);
  let rest = toks;
  let consumed = cutConsumed;
  if (rest[0] === CUT && node.dash === undefined && !consumed) {
    rest = rest.slice(1);
    consumed = true;
  }
  if (rest[0] === CUT && node.dash !== undefined) {
    return walkSpine(node.dash, rest.slice(1), depth + 1, true, acc);
  }
  const next = tokenAt(rest, 0);
  const child = commandChild(node, next);
  if (child) walkSpine(child, rest.slice(1), depth + 1, consumed, acc);
  return acc;
}

function stripCut(toks: readonly string[]): readonly string[] {
  const i = toks.indexOf(CUT);
  if (i === -1) return toks;
  return [...toks.slice(0, i), ...toks.slice(i + 1)];
}

function matcherLabel(matcher: Matcher): string {
  const parts = [
    ...Object.keys(matcher.flags),
    ...matcher.toks.map((tok) => `tok:${tok}`),
    ...matcher.globs.map((glob) => `glob:${glob}`),
  ];
  return parts.length === 0 ? "*" : parts.join("+");
}

function evalMatcher(
  matcher: Matcher,
  toks: readonly string[],
  flags: Readonly<Record<string, readonly string[]>>,
  bindings: Readonly<Record<string, number>>,
  depth: number,
  parent: Inherited,
): FloorVerdict | undefined {
  if (!flagsMatch(matcher.flags, flags, bindings, depth)) return undefined;
  if (!positionalsMatch(matcher, toks)) return undefined;
  const cls = matcher.class ?? parent.cls;
  const here: Inherited = {
    policy: matcher.policy ?? parent.policy,
    cls,
    id: `${parent.id}[${matcherLabel(matcher)}]`,
  };
  const nested = matcher.matchers
    .map((child) => evalMatcher(child, toks, flags, bindings, depth, here))
    .filter((vote): vote is FloorVerdict => vote !== undefined);
  if (matcher.policy === undefined) {
    if (nested.length === 0) return undefined;
    return join(nested);
  }
  const own = cast(matcher.policy, cls, here.id);
  if (matcher.policy === "block") return join([own, ...nested]);
  if (nested.length === 0) return own;
  return join(nested);
}

function flagsMatch(
  spec: Readonly<Record<string, FlagConstraint>>,
  flags: Readonly<Record<string, readonly string[]>>,
  bindings: Readonly<Record<string, number>>,
  depth: number,
): boolean {
  const entries = Object.values(spec);
  if (entries.length === 0) return true;
  const applyShadow = entries.length === 1;
  return entries.every((flag) => flagHits(flag, flags, bindings, depth, applyShadow));
}

function flagHits(
  flag: FlagConstraint,
  flags: Readonly<Record<string, readonly string[]>>,
  bindings: Readonly<Record<string, number>>,
  depth: number,
  applyShadow: boolean,
): boolean {
  const live = applyShadow ? flag.names.filter((name) => (bindings[name] ?? depth) === depth) : flag.names;
  if (live.length === 0) return false;
  const present = live.filter((name) => Object.hasOwn(flags, name));
  if (present.length === 0) return false;
  if (flag.vals.length === 0) return true;
  return present.some((name) => (flags[name] ?? []).some((value) => flag.vals.some((glob) => globMatch(glob, value))));
}

function positionalsMatch(matcher: Matcher, toks: readonly string[]): boolean {
  if (matcher.globs.length === 0 && matcher.toks.length === 0) return true;
  return toks.some((tok) => matcher.toks.includes(tok) || matcher.globs.some((glob) => globMatch(glob, tok)));
}

function fileVotes(node: CommandNode, toks: readonly string[], paths: PathClusters): FloorVerdict[] {
  if (toks.length === 0) return [];
  const votes: FloorVerdict[] = [];
  for (const [i, tok] of toks.entries()) {
    const kind = i < node.argTypes.length ? node.argTypes[i] : node.argRestType;
    if (!kind) continue;
    votes.push(shellPathVote(kind, tok, paths));
  }
  return votes;
}

function shellPathVote(kind: ArgType, path: string, paths: PathClusters): FloorVerdict {
  return pathVote(kind, rebase(paths.cwd, path), paths);
}

/** A relative path is relative to the shell's cwd, not the workspace root. */
function rebase(cwd: string | undefined, path: string): string {
  if (cwd === undefined || cwd === "" || cwd === "." || path === "" || path.startsWith("/")) return path;
  if (path.startsWith("~") || path.includes("$")) return path;
  return `${cwd}/${path}`;
}

function redirVotes(
  redirects: readonly { readonly operator: string; readonly target: string }[],
  paths: PathClusters,
): FloorVerdict[] {
  return redirects.flatMap((redirect) => {
    const cluster = redirCluster(redirect.operator);
    if (cluster === undefined) return [];
    return [shellPathVote(cluster === "read" ? "read_path" : "write_path", redirect.target, paths)];
  });
}

function redirCluster(operator: string): "read" | "write" | undefined {
  if (operator.includes("<<")) return undefined;
  if (operator.includes(">")) return "write";
  if (operator.includes("<")) return "read";
  return undefined;
}

/** minimatch treats `/` as a separator. A token is not a path, so `/` is hidden first. */
const TOKEN_SLASH = "\u0001";
const TOKEN_GLOB: MinimatchOptions = {
  dot: true,
  nocomment: true,
  nonegate: true,
  nobrace: true,
  noext: true,
  noglobstar: true,
};

function globMatch(pattern: string, value: string): boolean {
  return minimatch(value.replaceAll("/", TOKEN_SLASH), pattern.replaceAll("/", TOKEN_SLASH), TOKEN_GLOB);
}

export { explainPath } from "./path-policy.js";
