/**
 * Argument guards: what an option table cannot say. A guard sees the command
 * node's positionals and flag bag and returns extra votes that join the node's
 * own vote on the strict lattice, so a guard can tighten a verdict, never lift it.
 *
 * `flag_paths` (option values typed as paths, glued short values included) is
 * a guard that every node gets for free.
 */

import { posix } from "node:path";

import { explainPath, explainShellPath, type PathTerm } from "./path-policy.js";
import type { ArgType, CommandNode, Disposition, FloorVerdict } from "./types.js";
import { cast } from "./verdict.js";

export type GuardPaths = {
  readonly read?: PathTerm;
  readonly write?: PathTerm;
  /** The shell would expand this question's words: judge braces and globs as what they could become. */
  readonly expand?: boolean;
  /** `dotglob` is set somewhere in the command: `*` may match a leading dot. */
  readonly dotglob?: boolean;
};

type Flags = Readonly<Record<string, readonly string[]>>;

type Guard = (toks: readonly string[], flags: Flags, paths: GuardPaths) => FloorVerdict[];

export function guardVotes(
  node: CommandNode,
  toks: readonly string[],
  flags: Flags,
  paths: GuardPaths,
): FloorVerdict[] {
  const positionals = toks.filter((tok) => tok !== "--");
  return [
    ...flagPathVotes(node.flagPaths, flags, paths),
    ...node.guards.flatMap((name) => (GUARD_TABLE[name] ?? unknownGuard)(positionals, flags, paths)),
  ];
}

function unknownGuard(): FloorVerdict[] {
  return [cast("ask", "unmodelled", "guard:unknown")];
}

export function pathVote(kind: ArgType, path: string, paths: GuardPaths): FloorVerdict {
  const cluster = kind === "read_path" ? paths.read : paths.write;
  if (cluster === undefined) return cast("ask", "unmodelled", `${kind === "read_path" ? "read" : "write"}:no-policy`);
  return paths.expand === true
    ? explainShellPath(cluster, path, { dotglob: paths.dotglob })
    : explainPath(cluster, path);
}

/**
 * `--output=F`, `--output F`, `-o F`, and glued `-oF`. An empty value (an
 * option that lost its operand, or a letter cluster such as `-ofile`) is an
 * unresolvable path and asks.
 */
function flagPathVotes(flagPaths: Readonly<Record<string, ArgType>>, flags: Flags, paths: GuardPaths): FloorVerdict[] {
  const votes: FloorVerdict[] = [];
  for (const [name, kind] of Object.entries(flagPaths)) {
    for (const value of flags[name] ?? []) votes.push(pathVote(kind, value, paths));
    if (name.startsWith("--") || name.length !== 2) continue;
    for (const key of Object.keys(flags)) {
      if (key.startsWith(name) && key.length > 2 && !key.startsWith("--")) {
        votes.push(pathVote(kind, key.slice(2), paths));
      }
    }
  }
  return votes;
}

/** True when `key` is `full` or an unambiguous long-option prefix of it (`--out` of `--output`). */
function isOption(key: string, full: string): boolean {
  return key === full || (key.startsWith("--") && key.length >= 3 && full.startsWith(key));
}

const GIT_CONFIG_DENY = [
  /^alias\./,
  /^include(if)?\./,
  /^core\.(hookspath|fsmonitor|sshcommand|pager|editor|askpass|gitproxy|attributesfile|excludesfile)$/,
  /^diff\..*(external|textconv|command)$/,
  /^(pager|credential|filter|merge|mergetool|difftool|man|web|browser|sequence|gpg|url|protocol|uploadpack|receivepack|safe|http|remote|submodule)\./,
];

/** Keys whose value no git code path turns into a program, a file read, or a file write. */
const GIT_CONFIG_INERT = new Set([
  "color.ui",
  "color.diff",
  "color.status",
  "color.branch",
  "color.log",
  "core.quotepath",
  "core.abbrev",
  "core.precomposeunicode",
  "core.filemode",
  "core.whitespace",
  "diff.renames",
  "diff.context",
  "diff.algorithm",
  "log.date",
  "log.abbrevcommit",
  "status.showuntrackedfiles",
  "status.branch",
  "status.short",
  "advice.statushints",
  "user.name",
  "user.email",
]);

/**
 * `-c key=value` allowlist (case-insensitive: git folds the section and key).
 * Exec/include keys deny, anything unknown asks. `--config-env` always asks.
 */
function gitConfig(_toks: readonly string[], flags: Flags): FloorVerdict[] {
  const votes: FloorVerdict[] = [];
  for (const raw of flags["-c"] ?? []) {
    const key = raw.split("=", 1)[0]!.trim().toLowerCase();
    if (GIT_CONFIG_DENY.some((rule) => rule.test(key))) votes.push(cast("deny", "exec-unknown", "guard:git-config"));
    else if (!GIT_CONFIG_INERT.has(key)) votes.push(cast("ask", "unmodelled", "guard:git-config"));
  }
  if (Object.keys(flags).includes("--config-env")) votes.push(cast("ask", "exec-unknown", "guard:git-config-env"));
  return votes;
}

const REV_SYNTAX = /[~^@{}]/;

/**
 * diff/log/show operands are revisions or paths. `--no-index` makes every
 * operand a file git reads; otherwise a `rev:path` or bare operand that is
 * not revision syntax is read as a path too (`git diff -- .env`, `git show HEAD:.env`).
 */
function gitReads(toks: readonly string[], flags: Flags, paths: GuardPaths): FloorVerdict[] {
  const noIndex = Object.keys(flags).some((key) => isOption(key, "--no-index"));
  if (noIndex) return toks.map((tok) => pathVote("read_path", tok, paths));
  const votes: FloorVerdict[] = [];
  for (const tok of toks) {
    for (const part of tok.split(/\.{2,3}/)) {
      const target = part.includes(":") ? part.slice(part.indexOf(":") + 1) : part;
      if (target === "" || REV_SYNTAX.test(target)) continue;
      votes.push(pathVote("read_path", target, paths));
    }
  }
  return votes;
}

const SED_SAFE_FLAGS = [
  "--quiet",
  "--silent",
  "--regexp-extended",
  "--separate",
  "--unbuffered",
  "--null-data",
  "--posix",
  "--sandbox",
  "--debug",
  "--follow-symlinks",
  "--expression",
];
const SED_OTHER_LONG = ["--file", "--in-place", "--line-length", "--help", "--version", "--binary"];
const SED_SAFE_SHORT = new Set(["-n", "-E", "-r", "-s", "-u", "-z", "-e"]);

function sedFlagVote(key: string): Disposition | undefined {
  if (isOption(key, "--in-place")) return "deny";
  if (key.startsWith("--")) {
    const safe = SED_SAFE_FLAGS.some((full) => isOption(key, full));
    const other = SED_OTHER_LONG.some((full) => isOption(key, full));
    return safe && !other ? undefined : "ask";
  }
  if (key.startsWith("-i") || key.startsWith("-I")) return "deny";
  if (key.startsWith("-e") && key.length > 2) return undefined; // glued script, validated below
  return SED_SAFE_SHORT.has(key) ? undefined : "ask";
}

function sedIsBoolean(key: string): boolean {
  if (key.startsWith("--")) return sedFlagVote(key) === undefined && !isOption(key, "--expression");
  return SED_SAFE_SHORT.has(key) && key !== "-e";
}

function sedScripts(toks: readonly string[], flags: Flags): { scripts: string[]; files: readonly string[] } {
  const scripts: string[] = [];
  for (const [key, values] of Object.entries(flags)) {
    if (key === "-e" || isOption(key, "--expression")) scripts.push(...values.filter((value) => value !== ""));
    else if (key.startsWith("-e") && !key.startsWith("--") && key.length > 2) scripts.push(key.slice(2));
  }
  if (scripts.length > 0) return { scripts, files: toks };
  return { scripts: toks.slice(0, 1), files: toks.slice(1) };
}

/**
 * sed: in-place edits deny; a script that is anything but plain addressed
 * `s`/`y`/`p`/`d`/`q`/`n`-style commands with benign `s` flags asks. That drops the file
 * writers (`w`, `W`, `s///w`) and the program runners (`e`, `s///e`), and `r`/`R` file reads.
 * File operands are reads.
 */
function sed(toks: readonly string[], flags: Flags, paths: GuardPaths): FloorVerdict[] {
  const votes = Object.keys(flags).flatMap((key) => {
    const vote = sedFlagVote(key);
    if (vote === undefined) return [];
    return [
      vote === "deny"
        ? cast("deny", "workspace-write", "guard:sed-in-place")
        : cast("ask", "exec-unknown", "guard:sed-flag"),
    ];
  });
  // `-n SCRIPT` also parses as `-n` taking SCRIPT as a value. The other reading (boolean flag, SCRIPT a
  // positional) is enumerated and judged on its own, so this one has no script or files to inspect.
  const swallowed = Object.entries(flags).some(([key, values]) => sedIsBoolean(key) && values.some((v) => v !== ""));
  if (swallowed) return votes;
  const { scripts, files } = sedScripts(toks, flags);
  if (scripts.length === 0 || !scripts.every((script) => sedScriptIsPlain(script))) {
    votes.push(cast("ask", "exec-unknown", "guard:sed-script"));
  }
  for (const file of files) votes.push(pathVote("read_path", file, paths));
  return votes;
}

const SED_SIMPLE = new Set(["p", "P", "d", "D", "g", "G", "h", "H", "x", "n", "N", "=", "l", "q", "Q", "z"]);

/** Conservative sed parser: true only for scripts it fully understands and finds inert. */
export function sedScriptIsPlain(script: string): boolean {
  let i = 0;
  let depth = 0;
  const n = script.length;
  const blank = (c: string | undefined) => c === " " || c === "\t";
  const digit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9";
  const space = () => {
    while (i < n && blank(script[i])) i += 1;
  };
  /** Consume up to the unescaped delimiter. Returns false when unterminated. */
  const delimited = (delim: string): boolean => {
    while (i < n) {
      const c = script[i]!;
      i += 1;
      if (c === "\\") {
        i += 1;
        continue;
      }
      if (c === delim) return true;
    }
    return false;
  };
  const address = (): boolean => {
    const c = script[i];
    if (c === "$") {
      i += 1;
      return true;
    }
    if (digit(c)) {
      while (digit(script[i])) i += 1;
      if (script[i] === "~") {
        i += 1;
        while (digit(script[i])) i += 1;
      }
      return true;
    }
    if (c === "/" || c === "\\") {
      let delim = "/";
      if (c === "\\") {
        i += 1;
        delim = script[i] ?? "";
        if (delim === "" || delim === "\\" || delim === "\n") return false;
      }
      i += 1;
      if (!delimited(delim)) return false;
      while (script[i] === "I" || script[i] === "M") i += 1;
      return true;
    }
    return false;
  };
  const ending = (): boolean => {
    space();
    const c = script[i];
    return c === undefined || c === ";" || c === "\n" || c === "}";
  };
  while (i < n) {
    while (i < n && (blank(script[i]) || script[i] === ";" || script[i] === "\n")) i += 1;
    if (i >= n) break;
    if (script[i] === "}") {
      depth -= 1;
      if (depth < 0) return false;
      i += 1;
      continue;
    }
    if (address()) {
      space();
      if (script[i] === ",") {
        i += 1;
        space();
        if (script[i] === "+" || script[i] === "~") i += 1;
        if (!address()) return false;
      }
    }
    space();
    while (script[i] === "!") {
      i += 1;
      space();
    }
    const cmd = script[i];
    if (cmd === undefined) return false;
    i += 1;
    if (cmd === "{") {
      depth += 1;
      continue;
    }
    if (cmd === "s" || cmd === "y") {
      const delim = script[i];
      if (delim === undefined || delim === "\\" || delim === "\n" || blank(delim)) return false;
      i += 1;
      if (!delimited(delim) || !delimited(delim)) return false;
      if (cmd === "s") {
        while (i < n && "gpiImM0123456789".includes(script[i]!)) i += 1;
      }
      if (!ending()) return false;
      continue;
    }
    if (SED_SIMPLE.has(cmd)) {
      if (cmd === "q" || cmd === "Q" || cmd === "l") {
        space();
        while (digit(script[i])) i += 1;
      }
      if (!ending()) return false;
      continue;
    }
    return false;
  }
  return depth === 0;
}

/**
 * Catastrophic shapes: the few commands whose one run cannot be undone, so no mode may
 * lift them (`block`, not `deny`). A guard only tightens, so the node keeps its soft vote
 * for every other form and these arms add the hard one.
 *
 * Operands are read from positionals and from flag values alike: `rm -r /` parses both as
 * a boolean `-r` plus operand `/` and as `-r` taking `/`, and either reading must see it.
 */
const ROOT_LIKE = new Set([
  "/",
  "/*",
  "/.",
  "~",
  "~/",
  "~/*",
  "~/.",
  "$HOME",
  "$HOME/",
  "$HOME/*",
  "$HOME/.",
  "${HOME}",
  "${HOME}/",
  "${HOME}/*",
  "${HOME}/.",
]);

/** `/`, `/*`, `~`, `~/`, `$HOME` and their `//`, `/.` spellings. Not `/tmp/x`, not `./`. */
function isRootLike(word: string): boolean {
  const squeezed = word.replace(/\/{2,}/g, "/");
  if (ROOT_LIKE.has(squeezed)) return true;
  // `/.`, `/./`, `~/.`: no-op segments after the head.
  const plain = squeezed.replace(/(?<=.)\/\.(?=\/|$)/g, "");
  return plain !== squeezed && ROOT_LIKE.has(plain);
}

function operands(toks: readonly string[], flags: Flags): string[] {
  return [...toks, ...Object.values(flags).flat()];
}

/** `-R`, `--recursive`, or a short cluster that carries `r`/`R` (`-rf`, `-fR`). */
function isRecursive(flags: Flags): boolean {
  return Object.keys(flags).some(
    (key) => isOption(key, "--recursive") || (/^-[A-Za-z]+$/.test(key) && /[rR]/.test(key)),
  );
}

function hasOption(flags: Flags, full: string): boolean {
  return Object.keys(flags).some((key) => isOption(key, full));
}

/** rm/chmod/chown: `--no-preserve-root`, or recursion over the filesystem root or the home directory. */
function recursiveRoot(toks: readonly string[], flags: Flags): FloorVerdict[] {
  if (hasOption(flags, "--no-preserve-root")) return [catastrophe("guard:no-preserve-root")];
  return isRecursive(flags) && operands(toks, flags).some(isRootLike) ? [catastrophe("guard:recursive-root")] : [];
}

function catastrophe(ruleId: string): FloorVerdict {
  return cast("block", "destroy-catastrophic", ruleId);
}

/** Device nodes dd may write without harm. Everything else under /dev is a disk, a tty, or memory. */
const DD_HARMLESS_DEVICES = new Set(["/dev/null", "/dev/zero", "/dev/full", "/dev/stdout", "/dev/stderr", "/dev/tty"]);

/** dd: `of=` a device node. */
function ddDevice(toks: readonly string[], flags: Flags): FloorVerdict[] {
  const hit = operands(toks, flags).some((word) => {
    if (!word.startsWith("of=")) return false;
    const target = posix.normalize(word.slice(3));
    if (!target.startsWith("/dev/")) return false;
    return !DD_HARMLESS_DEVICES.has(target) && !target.startsWith("/dev/fd/");
  });
  return hit ? [catastrophe("guard:dd-device")] : [];
}

const PARTED_READS = new Set(["print", "p", "free", "all", "list", "devices"]);

/**
 * Partition editors. The listing forms read; every other invocation (including the
 * interactive ones, whose commands arrive on stdin) can rewrite the table.
 */
function diskWrite(toks: readonly string[], flags: Flags): FloorVerdict[] {
  const readOnly =
    ["--list", "--show-size", "--version", "--help"].some((full) => hasOption(flags, full)) ||
    ["-l", "-s", "-V", "-h"].some((short) => Object.hasOwn(flags, short));
  if (readOnly) return [];
  // parted names the device, then commands: only the printing ones are a read.
  const commands = toks.filter((tok) => !tok.startsWith("/dev/"));
  const printing = commands.length > 0 && commands.every((tok) => PARTED_READS.has(tok));
  return printing ? [] : [catastrophe("guard:disk-write")];
}

const GUARD_TABLE: Readonly<Record<string, Guard>> = {
  "git-config": gitConfig,
  "git-reads": gitReads,
  sed,
  "recursive-root": recursiveRoot,
  "dd-device": ddDevice,
  "disk-write": diskWrite,
};

export const GUARDS: ReadonlySet<string> = new Set(Object.keys(GUARD_TABLE));
