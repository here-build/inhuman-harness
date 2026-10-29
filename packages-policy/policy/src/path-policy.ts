/**
 * File-access cluster: policy.json `read_file` / `write_file` enable lists
 * and `read_block` / `write_block` hard-block lists.
 * Enable `!` is deny (remainder carve-out). Block lists are unliftable.
 * Suffix wildcard is implied — PAT matches itself and descendants.
 * Miss is deny (closed). Unresolvable path is ask.
 * Read enable is approve (silent in-tree). Write enable is ask: the list is
 * what the agent may attempt, not a grant. Yolo rewrites that ask and deny.
 * Realpath / cwd / ~ live on the host; this matcher sees the prepared string.
 *
 * Every rule carries a class (why it votes). Brace and glob words from the shell are expanded
 * lexically against the block rules: if any expansion or match could hit one, the word is `block`.
 */

import { posix } from "node:path";

import { minimatch } from "minimatch";

import type { ClassId } from "./classes.js";
import { expandBraces } from "./glob-expand.js";
import { lattice } from "./lift.js";
import type { Disposition, FloorVerdict, WriteRemainderKind } from "./types.js";
import { APPROVE, cast, join } from "./verdict.js";

type PathRule = {
  readonly id: string;
  readonly polarity: "policyApprove" | "ask" | "deny" | "block";
  readonly stem: string;
  readonly unanchored: boolean;
  readonly class: ClassId;
};

export type PathTerm = {
  readonly cluster: "read" | "write";
  readonly rules: PathRule[];
  /** Class of a miss (deny: outside the enable roots). */
  readonly missClass: ClassId;
};

export function mergePathTerms(
  cluster: "read" | "write",
  missClass: ClassId,
  enable: readonly PathRule[] | undefined,
  block: readonly PathRule[] | undefined,
): PathTerm | undefined {
  if (enable === undefined && block === undefined) return undefined;
  return { cluster, missClass, rules: [...(enable ?? []), ...(block ?? [])] };
}

export function checkPath(term: PathTerm, path: string): Disposition {
  return explainPath(term, path).disposition;
}

/** The disposition of one path with the rules that decided it. */
export function explainPath(term: PathTerm, path: string): FloorVerdict {
  const resolved = normalizePath(path);
  if (resolved === undefined) {
    return cast("ask", "unmodelled", `${term.cluster}:unresolvable`, { path: { cluster: term.cluster, path } });
  }
  const hits = term.rules.filter((rule) => matchesRule(rule, resolved));
  const where = { path: { cluster: term.cluster, path: resolved } } as const;
  if (hits.length === 0) return cast("deny", term.missClass, `${term.cluster}:miss`, where);
  return join(hits.map((rule) => cast(rule.polarity, rule.class, rule.id, where)));
}

/**
 * Shell words may carry braces and globs. A word the shell would expand is judged as every
 * word it could expand to; a glob is judged as everything it could match. The result is the
 * strictest of those and the word itself, so this can only tighten. Only block rules can be
 * hit by a pattern (an enable root never needs a glob to be understood: the word asks).
 */
export function explainShellPath(
  term: PathTerm,
  word: string,
  options: { readonly dotglob?: boolean } = {},
): FloorVerdict {
  const plain = explainPath(term, word);
  if (!/[{*?[]/.test(word)) return plain;
  const { words: expandedWords, overflow } = expandBraces(word);
  // `a/../.e{nv,x}`: collapse `..` lexically so the block rule sees the name it will open.
  const words = [...expandedWords, ...expandedWords.map(collapseDots).filter((w) => !expandedWords.includes(w))];
  const verdicts: FloorVerdict[] = [plain];
  for (const expanded of words) {
    if (!/[*?[]/.test(expanded)) {
      if (expanded !== word) verdicts.push(explainPath(term, expanded));
      continue;
    }
    const hit = globBlockHit(term, expanded, options.dotglob === true);
    if (hit !== undefined)
      verdicts.push(cast("block", hit.class, hit.id, { path: { cluster: term.cluster, path: word } }));
  }
  if (overflow) {
    const hit = globBlockHit(term, wildcardBraces(word), options.dotglob === true);
    if (hit !== undefined)
      verdicts.push(cast("block", hit.class, hit.id, { path: { cluster: term.cluster, path: word } }));
  }
  return join(verdicts);
}

function collapseDots(word: string): string {
  return word.includes("..") ? posix.normalize(word) : word;
}

/** Every outermost `{...}` group becomes `*`: a superset of whatever the group could expand to. */
function wildcardBraces(word: string): string {
  let depth = 0;
  let out = "";
  for (const ch of word) {
    if (ch === "{") {
      if (depth === 0) out += "*";
      depth += 1;
    } else if (ch === "}" && depth > 0) {
      depth -= 1;
    } else if (depth === 0) {
      out += ch;
    }
  }
  return out;
}

/**
 * Could a path matching glob `pattern` be blocked? Segment by segment: `*` and `?` do not cross `/`
 * and (like bash without `dotglob`) do not match a leading dot. Case and Unicode form are folded the
 * way the block rules fold them.
 */
function globBlockHit(term: PathTerm, pattern: string, dotglob: boolean): PathRule | undefined {
  const slash = pattern.replaceAll("\\", "/").normalize("NFC").toLowerCase();
  const absolute = slash.startsWith("/");
  const segments = slash.split("/").filter((seg) => seg !== "" && seg !== ".");
  for (const rule of term.rules) {
    if (rule.polarity !== "block") continue;
    const stem = rule.stem.normalize("NFC").toLowerCase();
    if (stem === ".") continue;
    const stemSegments = stem.split("/").filter((seg) => seg !== "");
    if (rule.unanchored) {
      const name = stemSegments[0];
      const at = name === undefined ? -1 : segments.findIndex((seg) => segmentMatches(seg, name, dotglob));
      // `.claude/worktrees` is not under the `.claude` block, glob or not.
      if (at !== -1 && !(rule.stem === ".claude" && segments[at + 1] === "worktrees")) return rule;
      continue;
    }
    if (stem.startsWith("/") !== absolute) continue;
    if (prefixMatches(segments, stemSegments, dotglob)) return rule;
  }
  return undefined;
}

/** `**` stands for any number of segments (zsh and bash with globstar). */
function prefixMatches(pattern: readonly string[], stem: readonly string[], dotglob: boolean): boolean {
  if (stem.length === 0) return true;
  const [head, ...rest] = pattern;
  if (head === undefined) return false;
  if (head === "**") {
    return prefixMatches(rest, stem, dotglob) || prefixMatches(pattern, stem.slice(1), dotglob);
  }
  const [name, ...more] = stem;
  return segmentMatches(head, name!, dotglob) && prefixMatches(rest, more, dotglob);
}

function segmentMatches(pattern: string, name: string, dotglob: boolean): boolean {
  if (pattern === name) return true;
  if (!/[*?[\]{}()!+@]/.test(pattern)) return false;
  // A segment with nothing literal in it (`*`, `??`, `[ab]`) matches every file name; treating that as a hit
  // would block `cat *`. It still reaches dot-files when `dotglob` is set.
  const literal = pattern.replaceAll(/\[[^\]]*\]|[*?]/g, "");
  if (literal === "" && !(dotglob && name.startsWith("."))) return false;
  return minimatch(name, pattern, { dot: dotglob, nocase: true, nocomment: true, nonegate: true, noglobstar: true });
}

/**
 * Write-deny remainder intern. Null when the floor is not deny.
 * protected: enable `!` inside an enable root. outside: miss, left the
 * enable set. risky: enable `!` and left the enable set. `write_block`
 * never reaches this.
 */
export function writeRemainderKind(term: PathTerm, path: string): WriteRemainderKind | null {
  const resolved = normalizePath(path);
  switch (true) {
    case resolved === undefined:
    case checkPath(term, path) !== "deny":
      return null;
    case !term.rules.some((rule) => resolved !== undefined && rule.polarity === "deny" && matchesRule(rule, resolved)):
      return "outside";
    case term.rules.some(
      (rule) =>
        resolved !== undefined &&
        (rule.polarity === "ask" || rule.polarity === "policyApprove") &&
        matchesRule(rule, resolved),
    ):
      return "protected";
    default:
      return "risky";
  }
}

/**
 * Block / deny rules fold case and Unicode form: macOS (APFS) and Windows open `.ENV` and `.env`
 * as one file, so a case variant must not walk past the rule. A false block is safe; a miss
 * is not. Enable rules stay exact: folding them would approve paths the list never named.
 */
function fold(path: string): string {
  return path.normalize("NFC").toLowerCase();
}

function matchesRule(rule: PathRule, exact: string): boolean {
  const folded = rule.polarity === "block" || rule.polarity === "deny";
  const resolved = folded ? fold(exact) : exact;
  const stem = folded ? fold(rule.stem) : rule.stem;
  switch (true) {
    case rule.stem === ".":
      return isRelative(resolved);
    case rule.unanchored && hasSegment(resolved, stem):
    case !rule.unanchored && isPrefix(resolved, stem):
      return !(rule.polarity === "block" && rule.stem === ".claude" && isClaudeWorktree(resolved));
    default:
      return false;
  }
}

/** `.claude` write_block does not cover `.claude/worktrees` (any depth). */
function isClaudeWorktree(path: string): boolean {
  switch (true) {
    case path === ".claude/worktrees":
    case path.startsWith(".claude/worktrees/"):
    case path.includes("/.claude/worktrees/"):
    case path.endsWith("/.claude/worktrees"):
      return true;
    default:
      return false;
  }
}

function isPrefix(path: string, stem: string): boolean {
  switch (true) {
    case path === stem:
      return true;
    case stem === "/":
      return path.startsWith("/");
    default:
      return path.startsWith(`${stem}/`);
  }
}

function hasSegment(path: string, stem: string): boolean {
  switch (true) {
    case path === stem:
    case path.startsWith(`${stem}/`):
    case path.includes(`/${stem}/`):
    case path.endsWith(`/${stem}`):
      return true;
    default:
      return false;
  }
}

function isRelative(path: string): boolean {
  return path !== "/" && !path.startsWith("/");
}

/** Undefined = unresolvable (ask). No `..`, `~`, `$`, glob, NUL. */
export function normalizePath(raw: string): string | undefined {
  const slash = raw.replaceAll("\\", "/");
  const parts = slash.split("/").filter((seg) => seg !== "" && seg !== ".");
  switch (true) {
    case raw === "" || raw.includes("\0"):
    case /[~$?*`\0]/.test(slash):
    case parts.includes(".."):
      return undefined;
    case slash.startsWith("/") && parts.length === 0:
      return "/";
    case slash.startsWith("/"):
      return `/${parts.join("/")}`;
    case parts.length === 0:
      return ".";
    default:
      return parts.join("/");
  }
}

export { APPROVE, lattice };
