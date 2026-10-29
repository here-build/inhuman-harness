/**
 * Question prep: unbash AST → prepared questions + unparsed acts.
 * Hermetic — no PATH, no process.env, no execution. Word.parts is a lazy
 * getter; this file always reads it. Nested parse errors live on the nested
 * script, not the root.
 *
 * Partition builds I: a known value-flag attaches; an unknown flag followed
 * by a non-dash, non-`--` token forks attached and boolean readings.
 * `valueFlagsFor(argv0, suffix)` sees the leading positional spine — not
 * every descendant under argv0. `=value` and glued shorts stay one reading.
 * `--` never attaches as a value. Cap 16 is open ruling 5; overflow is ⊤I.
 * A nameless command still emits its redirects. `xargs -a FILE` is a read
 * of FILE as well as the inner command.
 */

import {
  parse,
  type ArithmeticExpression,
  type AssignmentPrefix,
  type Command,
  type Node as BashNode,
  type ParseError,
  type ParsedScript,
  type Redirect,
  type Statement,
  type TestExpression,
  type Word,
  type WordPart,
} from "unbash";

import { resolveKnown, type Which } from "./identity.js";
import type { Question, Reading } from "./types.js";

type UnparsedVia =
  | "parse-error"
  | "control-flow"
  | "function"
  | "source"
  | "test"
  | "arithmetic"
  | "coproc"
  | "find-expression"
  | "non-literal-argv0"
  | "script-string";

type UnparsedAct = {
  readonly via: UnparsedVia;
  readonly source: string;
};

type RedirectEmit = {
  readonly operator: string;
  readonly target: string;
};

type PreparedQuestion = Question & {
  readonly wrapChain: readonly string[];
  readonly elevated: boolean;
  readonly envDelta: Readonly<Record<string, string>>;
  /** Some argument (or env value) is not fully literal: `$x`, backticks, `$(…)`, brace/bracket/`*`/`?` globs. */
  readonly nonLiteral: boolean;
  readonly redirects: readonly RedirectEmit[];
  readonly background: boolean;
  readonly stdinIsPipe: boolean;
};

type PrepResult = {
  readonly questions: readonly PreparedQuestion[];
  readonly unparsed: readonly UnparsedAct[];
  readonly errors: readonly ParseError[];
  /** File effects from commands that have no argv0 (`> .env`). */
  readonly redirects: readonly RedirectEmit[];
};

const TRANSPARENT_FLAG_ARGS: Readonly<Record<string, readonly string[]>> = {
  xargs: ["-a", "-d", "-E", "-e", "-I", "-i", "-L", "-l", "-n", "-P", "-s"],
  env: ["-C", "-S", "-u"],
  timeout: ["-k", "--kill-after", "-s", "--signal"],
  nice: ["-n"],
  watch: ["-n", "-d", "-t", "-e"],
  time: ["-p"],
  stdbuf: ["-i", "-o", "-e"],
  exec: ["-a"],
  sudo: ["-C", "-D", "-g", "-l", "-p", "-r", "-U", "-u"],
  doas: ["-C", "-u"],
};

/** Duration is the first positional; COMMAND follows. */
const HOF_SKIP_POSITIONALS: Readonly<Record<string, number>> = { timeout: 1 };

const PARTLESS_FORBIDDEN = /[*?[\\$`]/;

type PrepOpts = {
  readonly valueFlags?: ReadonlySet<string>;
  readonly valueFlagsFor?: (argv0: string, suffix: readonly string[]) => ReadonlySet<string> | undefined;
  /** Path-form peelers are transparent only when this agrees. */
  readonly which?: Which;
};

export function prep(source: string, opts?: PrepOpts): PrepResult {
  const script = parse(source);
  const errors = [...(script.errors ?? [])];
  if (errors.length > 0) {
    return { questions: [], unparsed: [{ via: "parse-error", source }], errors, redirects: [] };
  }
  const ctx: Ctx = {
    questions: [],
    unparsed: [],
    wrapChain: [],
    elevated: false,
    envDelta: {},
    nonLiteral: false,
    source,
    valueFlags: opts?.valueFlags,
    valueFlagsFor: opts?.valueFlagsFor,
    which: opts?.which,
    accessReads: [],
    orphans: [],
  };
  walkScript(script, ctx, { background: false, stdinIsPipe: false, redirects: [] });
  return { questions: ctx.questions, unparsed: ctx.unparsed, errors, redirects: ctx.orphans };
}

type Frame = {
  readonly background: boolean;
  readonly stdinIsPipe: boolean;
  readonly redirects: readonly Redirect[];
};

type Ctx = {
  questions: PreparedQuestion[];
  unparsed: UnparsedAct[];
  wrapChain: string[];
  elevated: boolean;
  envDelta: Record<string, string>;
  nonLiteral: boolean;
  source: string;
  valueFlags: ReadonlySet<string> | undefined;
  valueFlagsFor: ((argv0: string, suffix: readonly string[]) => ReadonlySet<string> | undefined) | undefined;
  which: Which | undefined;
  accessReads: readonly string[];
  orphans: RedirectEmit[];
};

function walkScript(script: ParsedScript, ctx: Ctx, frame: Frame): void {
  if (script.errors !== undefined && script.errors.length > 0) {
    ctx.unparsed.push({ via: "parse-error", source: ctx.source.slice(script.pos, script.end) });
    return;
  }
  for (const statement of script.commands) walkStatement(statement, ctx, frame);
}

function walkStatement(statement: Statement, ctx: Ctx, frame: Frame): void {
  walkNode(statement.command, ctx, {
    background: statement.background === true || frame.background,
    stdinIsPipe: frame.stdinIsPipe,
    redirects: [...frame.redirects, ...statement.redirects],
  });
}

function walkNode(node: BashNode, ctx: Ctx, frame: Frame): void {
  switch (node.type) {
    case "Statement":
      walkStatement(node, ctx, frame);
      return;
    case "CompoundList":
      for (const statement of node.commands) walkStatement(statement, ctx, frame);
      return;
    case "Pipeline": {
      const wrap = node.time === true ? withWrap(ctx, "time") : ctx;
      for (const [i, child] of node.commands.entries()) {
        walkNode(child, wrap, { ...frame, stdinIsPipe: frame.stdinIsPipe || i > 0 });
      }
      return;
    }
    case "AndOr":
      for (const child of node.commands) walkNode(child, ctx, frame);
      return;
    case "Subshell":
    case "BraceGroup":
      walkNode(node.body, ctx, frame);
      return;
    case "If":
    case "For":
    case "ArithmeticFor":
    case "While":
    case "Select":
    case "Case":
      ctx.unparsed.push({ via: "control-flow", source: slice(ctx, node) });
      walkControlInner(node, ctx, frame);
      return;
    case "Function":
      ctx.unparsed.push({ via: "function", source: slice(ctx, node) });
      return;
    case "Coproc":
      ctx.unparsed.push({ via: "coproc", source: slice(ctx, node) });
      walkNode(node.body, ctx, frame);
      return;
    case "TestCommand":
      ctx.unparsed.push({ via: "test", source: slice(ctx, node) });
      walkTestWords(node.expression, ctx, frame);
      return;
    case "ArithmeticCommand":
      ctx.unparsed.push({ via: "arithmetic", source: slice(ctx, node) });
      walkArith(node.expression, ctx, frame);
      return;
    case "Command":
      walkCommand(node, ctx, frame);
      return;
  }
}

function walkControlInner(node: BashNode, ctx: Ctx, frame: Frame): void {
  switch (node.type) {
    case "If":
      walkNode(node.clause, ctx, frame);
      walkNode(node.then, ctx, frame);
      if (node.else !== undefined) walkNode(node.else, ctx, frame);
      return;
    case "For":
    case "Select":
      walkWord(node.name, ctx, frame);
      for (const word of node.wordlist) walkWord(word, ctx, frame);
      walkNode(node.body, ctx, frame);
      return;
    case "ArithmeticFor":
      walkArith(node.initialize, ctx, frame);
      walkArith(node.test, ctx, frame);
      walkArith(node.update, ctx, frame);
      walkNode(node.body, ctx, frame);
      return;
    case "While":
      walkNode(node.clause, ctx, frame);
      walkNode(node.body, ctx, frame);
      return;
    case "Case":
      walkWord(node.word, ctx, frame);
      for (const item of node.items) {
        for (const pattern of item.pattern) walkWord(pattern, ctx, frame);
        walkNode(item.body, ctx, frame);
      }
      return;
    default:
      return;
  }
}

function walkCommand(command: Command, ctx: Ctx, frame: Frame): void {
  const envDelta = { ...ctx.envDelta };
  let nonLiteral = ctx.nonLiteral;
  for (const prefix of command.prefix) {
    takeAssignment(prefix, envDelta);
    if (prefix.value !== undefined && !isInertWord(prefix.value)) nonLiteral = true;
    if (prefix.array !== undefined) nonLiteral = true;
    walkAssignment(prefix, ctx, frame);
  }
  const redirects = [...frame.redirects, ...command.redirects];
  for (const redirect of redirects) walkRedirect(redirect, ctx, frame);

  if (command.name === undefined) {
    ctx.orphans.push(...redirects.flatMap(emitRedirect));
    return;
  }

  const argv0Word = command.name;
  walkWord(argv0Word, ctx, frame);

  if (!isLiteralWord(argv0Word)) {
    for (const word of command.suffix) walkWord(word, ctx, frame);
    ctx.unparsed.push({ via: "non-literal-argv0", source: slice(ctx, command) });
    return;
  }

  const raw = argv0Word.value;
  const argv0 = peelName(raw, ctx.which);
  const suffix = command.suffix.map((word) => word.value);
  if (!command.suffix.every(isInertWord)) nonLiteral = true;
  const innerCtx: Ctx = { ...ctx, envDelta, nonLiteral };

  switch (argv0) {
    case undefined:
      break;
    case "sudo":
    case "doas":
      emitCommand(innerCtx, raw, suffix, { ...frame, redirects }, true);
      peelInner(command, argv0, suffix, { ...innerCtx, elevated: true }, frame, redirects, true);
      return;
    case "source":
    case ".":
      for (const word of command.suffix) walkWord(word, ctx, frame);
      ctx.unparsed.push({ via: "source", source: slice(ctx, command) });
      return;
    case "find":
      for (const word of command.suffix) walkWord(word, ctx, frame);
      ctx.unparsed.push({ via: "find-expression", source: slice(ctx, command) });
      return;
    case "python":
    case "python3":
    case "node":
      if (hasScriptFlag(suffix)) {
        for (const word of command.suffix) walkWord(word, ctx, frame);
        ctx.unparsed.push({ via: "script-string", source: slice(ctx, command) });
        emitCommand(innerCtx, raw, suffix, { ...frame, redirects }, false);
        return;
      }
      break;
    case "eval":
      peelEval(command, innerCtx, frame, redirects);
      return;
    case "bash":
    case "sh":
    case "zsh":
    case "dash":
    case "ksh":
      peelShellC(command, argv0, suffix, innerCtx, frame, redirects);
      return;
    case "env":
      if (envHasDashFlags(suffix)) {
        for (const word of command.suffix) walkWord(word, ctx, frame);
        emitCommand(innerCtx, raw, suffix, { ...frame, redirects }, false);
        return;
      }
      peelInner(command, argv0, suffix, innerCtx, frame, redirects, false);
      return;
    case "xargs":
    case "timeout":
    case "nice":
    case "nohup":
    case "stdbuf":
    case "watch":
    case "time":
    case "command":
    case "exec":
    case "builtin":
      peelInner(command, argv0, suffix, innerCtx, frame, redirects, false);
      return;
  }
  for (const word of command.suffix) walkWord(word, ctx, frame);
  emitCommand(innerCtx, raw, suffix, { ...frame, redirects }, false);
}

function peelInner(
  command: Command,
  argv0: string,
  suffix: readonly string[],
  ctx: Ctx,
  frame: Frame,
  redirects: readonly Redirect[],
  keepWrapper: boolean,
): void {
  const flagArgs = TRANSPARENT_FLAG_ARGS[argv0];
  const skipAssign = argv0 === "env";
  const boundary = scanPassthroughBoundary(suffix, flagArgs, skipAssign) + (HOF_SKIP_POSITIONALS[argv0] ?? 0);
  const reads = wrapperFileReads(argv0, suffix);
  const innerCtx = reads.length === 0 ? ctx : { ...ctx, accessReads: [...ctx.accessReads, ...reads] };
  if (boundary >= suffix.length) {
    if (keepWrapper) {
      for (const word of command.suffix) walkWord(word, innerCtx, frame);
    } else {
      emitCommand(innerCtx, argv0, suffix, { ...frame, redirects }, false);
    }
    return;
  }
  for (const word of command.suffix.slice(0, boundary)) walkWord(word, innerCtx, frame);
  const envDelta = { ...innerCtx.envDelta };
  if (skipAssign) {
    for (const word of suffix.slice(0, boundary)) {
      if (isVarAssignment(word)) takeEnvText(word, envDelta);
    }
  }
  const nameWord = command.suffix[boundary]!;
  const wrapped = withWrap({ ...innerCtx, envDelta }, argv0);
  const inner: Command = {
    type: "Command",
    pos: nameWord.pos,
    end: command.end,
    name: nameWord,
    prefix: [],
    suffix: command.suffix.slice(boundary + 1),
    redirects: [],
  };
  walkCommand(inner, wrapped, { ...frame, redirects });
}

function peelShellC(
  command: Command,
  argv0: string,
  suffix: readonly string[],
  ctx: Ctx,
  frame: Frame,
  redirects: readonly Redirect[],
): void {
  for (const word of command.suffix) walkWord(word, ctx, frame);
  const body = scriptFlagBody(suffix, "-c");
  if (body === undefined) {
    emitCommand(ctx, argv0, suffix, { ...frame, redirects }, false);
    return;
  }
  const inner = parse(body);
  if (inner.errors !== undefined && inner.errors.length > 0) {
    ctx.unparsed.push({ via: "script-string", source: body });
    return;
  }
  walkScript(inner, withWrap(ctx, argv0), {
    background: frame.background,
    stdinIsPipe: frame.stdinIsPipe,
    redirects,
  });
}

function peelEval(command: Command, ctx: Ctx, frame: Frame, redirects: readonly Redirect[]): void {
  const suffix = command.suffix.map((word) => word.value);
  emitCommand(ctx, "eval", suffix, { ...frame, redirects }, false);
  if (suffix.length === 0) return;
  const body = suffix.join(" ");
  const inner = parse(body);
  if (inner.errors !== undefined && inner.errors.length > 0) {
    ctx.unparsed.push({ via: "script-string", source: body });
    return;
  }
  walkScript(inner, withWrap(ctx, "eval"), {
    background: frame.background,
    stdinIsPipe: frame.stdinIsPipe,
    redirects,
  });
}

function emitCommand(ctx: Ctx, argv0: string, suffix: readonly string[], frame: Frame, elevated: boolean): void {
  const { readings, overflow } = partition(suffix, ctx.valueFlagsFor?.(argv0, suffix) ?? ctx.valueFlags);
  ctx.questions.push({
    argv0,
    readings,
    ...(overflow ? { overflow: true as const } : {}),
    wrapChain: ctx.wrapChain,
    elevated: elevated || ctx.elevated,
    envDelta: ctx.envDelta,
    nonLiteral: ctx.nonLiteral,
    redirects: [
      ...frame.redirects.flatMap(emitRedirect),
      ...ctx.accessReads.map((target) => ({ operator: "<", target })),
    ],
    background: frame.background,
    stdinIsPipe: frame.stdinIsPipe,
  });
}

function emitRedirect(redirect: Redirect): RedirectEmit[] {
  if (redirect.target === undefined) return [];
  return [{ operator: redirect.operator, target: redirect.target.value }];
}

const READING_CAP = 16; // open ruling 5 (policy-algebra.md); overflow cannot prove deny/allow

/**
 * Tokenize argv into positionals + flag bag.
 * `closed`: only those names are flags; other dash tokens are positionals.
 * Used when a `"--"` field reopens the suffix — undeclared `-file` stays a path.
 */
export function partition(
  words: readonly string[],
  valueFlags: ReadonlySet<string> | undefined,
  closed?: ReadonlySet<string>,
): { readings: Reading[]; overflow: boolean } {
  const readings: Reading[] = [];
  let overflow = false;
  const rec = (
    i: number,
    cut: boolean,
    tokens: readonly string[],
    flags: Readonly<Record<string, readonly string[]>>,
  ): void => {
    if (overflow) return;
    if (i >= words.length) {
      if (readings.length >= READING_CAP) {
        overflow = true;
        return;
      }
      readings.push({ tokens, flags });
      return;
    }
    const word = words[i]!;
    if (cut || word === "--" || !word.startsWith("-") || word === "-" || !isDeclaredFlag(word, closed)) {
      rec(i + 1, cut || word === "--", [...tokens, word], flags);
      return;
    }
    if (word.startsWith("--")) {
      const eq = word.indexOf("=");
      if (eq !== -1) {
        rec(i + 1, cut, tokens, withFlag(flags, word.slice(0, eq), word.slice(eq + 1)));
        return;
      }
      takeFlag(words, i, cut, tokens, flags, word, true, valueFlags, rec);
      return;
    }
    const eq = word.indexOf("=");
    if (eq >= 2) {
      rec(i + 1, cut, tokens, withFlag(flags, word.slice(0, eq), word.slice(eq + 1)));
      return;
    }
    if (/^-[a-z]+$/i.test(word) && word.length > 2) {
      let nextFlags = flags;
      for (const ch of word.slice(1)) nextFlags = withFlag(nextFlags, `-${ch}`, "");
      rec(i + 1, cut, tokens, nextFlags);
      return;
    }
    takeFlag(words, i, cut, tokens, flags, word, word.length === 2, valueFlags, rec);
  };
  rec(0, false, [], {});
  return { readings, overflow };
}

type Rec = (
  i: number,
  cut: boolean,
  tokens: readonly string[],
  flags: Readonly<Record<string, readonly string[]>>,
) => void;

function takeFlag(
  words: readonly string[],
  i: number,
  cut: boolean,
  tokens: readonly string[],
  flags: Readonly<Record<string, readonly string[]>>,
  name: string,
  mayAttach: boolean,
  valueFlags: ReadonlySet<string> | undefined,
  rec: Rec,
): void {
  const next = words[i + 1];
  const canAttach = mayAttach && i + 1 < words.length && next !== "--" && !next.startsWith("-");
  if (canAttach && valueFlags?.has(name) === true) {
    rec(i + 2, cut, tokens, withFlag(flags, name, next!));
    return;
  }
  if (canAttach) {
    rec(i + 2, cut, tokens, withFlag(flags, name, next!));
    rec(i + 1, cut, tokens, withFlag(flags, name, ""));
    return;
  }
  rec(i + 1, cut, tokens, withFlag(flags, name, ""));
}

function isDeclaredFlag(word: string, closed: ReadonlySet<string> | undefined): boolean {
  if (closed === undefined) return true;
  if (word.startsWith("--")) {
    const eq = word.indexOf("=");
    return closed.has(eq === -1 ? word : word.slice(0, eq));
  }
  const eq = word.indexOf("=");
  if (eq >= 2) return closed.has(word.slice(0, eq));
  if (/^-[a-z]+$/i.test(word) && word.length > 2) {
    for (const ch of word.slice(1)) {
      if (!closed.has(`-${ch}`)) return false;
    }
    return true;
  }
  return closed.has(word);
}

function withFlag(
  flags: Readonly<Record<string, readonly string[]>>,
  name: string,
  val: string,
): Readonly<Record<string, readonly string[]>> {
  return { ...flags, [name]: [...(flags[name] ?? []), val] };
}

function scanPassthroughBoundary(
  args: readonly string[],
  flagArgs: readonly string[] | undefined,
  skipVarAssignments: boolean,
): number {
  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;
    if (skipVarAssignments && isVarAssignment(arg)) {
      i++;
      continue;
    }
    if (arg === "--") return i + 1;
    if (!arg.startsWith("-")) break;
    i += flagSpan(arg, i, args, flagArgs);
  }
  return i;
}

function flagSpan(arg: string, i: number, args: readonly string[], flagArgs: readonly string[] | undefined): number {
  if (arg.includes("=")) return 1;
  if (arg.length > 2 && !arg.startsWith("--") && takesValue(arg.slice(0, 2), flagArgs)) return 1;
  if (takesValue(arg, flagArgs) && i + 1 < args.length && !args[i + 1]!.startsWith("-")) {
    return 2;
  }
  return 1;
}

/** Wrapper-owned file reads that peeling must not drop. `xargs -a FILE` reads FILE. */
function wrapperFileReads(argv0: string, suffix: readonly string[]): string[] {
  if (argv0 !== "xargs") return [];
  const reads: string[] = [];
  for (let i = 0; i < suffix.length; i++) {
    const arg = suffix[i]!;
    if (arg === "--") break;
    if (arg === "-a" || arg === "--arg-file") {
      const next = suffix[i + 1];
      if (next !== undefined && next !== "--" && !next.startsWith("-")) {
        reads.push(next);
        i += 1;
      }
      continue;
    }
    if (arg.startsWith("--arg-file=") && arg.length > 11) reads.push(arg.slice(11));
    if (arg.startsWith("-a=") && arg.length > 3) reads.push(arg.slice(3));
  }
  return reads;
}

function takesValue(flag: string, flagArgs: readonly string[] | undefined): boolean {
  if (flagArgs === undefined) return false;
  const stripped = flag.replace(/^-+/, "");
  return flagArgs.some((name) => name.replace(/^-+/, "") === stripped);
}

function scriptFlagBody(suffix: readonly string[], flag: string): string | undefined {
  for (let i = 0; i < suffix.length; i++) {
    const arg = suffix[i]!;
    if (arg === flag) return suffix[i + 1];
    if (arg.startsWith(`${flag}=`) && arg.length > flag.length + 1) return arg.slice(flag.length + 1);
  }
  return undefined;
}

function hasScriptFlag(suffix: readonly string[]): boolean {
  return suffix.some((arg) => arg === "-c" || arg === "-e" || arg.startsWith("-c=") || arg.startsWith("-e="));
}

function isVarAssignment(arg: string): boolean {
  return /^[a-z_]\w*=/i.test(arg);
}

function takeAssignment(prefix: AssignmentPrefix, envDelta: Record<string, string>): void {
  if (prefix.name === undefined) return;
  envDelta[prefix.name] = prefix.value?.value ?? "";
}

function takeEnvText(text: string, envDelta: Record<string, string>): void {
  const eq = text.indexOf("=");
  if (eq <= 0) return;
  envDelta[text.slice(0, eq)] = text.slice(eq + 1);
}

function isLiteralWord(word: Word): boolean {
  if (word.parts === undefined) {
    return !PARTLESS_FORBIDDEN.test(word.text) && !word.text.startsWith("~");
  }
  return word.parts.every(partIsLiteral);
}

/**
 * Stricter than `isLiteralWord`: a word bash would pass through unchanged. Quoted
 * text is literal (`'a*'`, `"a b"`); an unquoted `*` `?` `[` glob, a `~` home, a
 * variable, a substitution, a brace/extglob form is not.
 */
function isInertWord(word: Word): boolean {
  const unescaped = (text: string): string => text.replaceAll(/\\./g, "");
  if (word.parts === undefined || word.parts.length === 0) {
    const text = unescaped(word.text);
    return !/[*?[$`]/.test(text) && !text.startsWith("~");
  }
  return word.parts.every((part, i) => {
    if (part.type === "Literal") {
      const text = unescaped(part.value);
      return !/[*?[$`]/.test(text) && !(i === 0 && text.startsWith("~"));
    }
    return partIsLiteral(part);
  });
}

function partIsLiteral(part: WordPart): boolean {
  switch (part.type) {
    case "Literal":
    case "SingleQuoted":
      return true;
    case "AnsiCQuoted":
      return !part.value.includes("\0");
    case "DoubleQuoted":
      return part.parts.every((child) => child.type === "Literal");
    default:
      return false;
  }
}

const PEEL_NAMES = new Set([
  "sudo",
  "doas",
  "source",
  ".",
  "find",
  "python",
  "python3",
  "node",
  "eval",
  "bash",
  "sh",
  "zsh",
  "dash",
  "ksh",
  "env",
  "xargs",
  "timeout",
  "nice",
  "nohup",
  "stdbuf",
  "watch",
  "time",
  "command",
  "exec",
  "builtin",
]);

/** Named peeler is itself. Path-form peels only when `which` agrees. */
function peelName(raw: string, which: Which | undefined): string | undefined {
  return resolveKnown(raw, PEEL_NAMES, which);
}

/** `env -C` / `-S` / `-u` change context this matcher does not apply. Do not peel. */
function envHasDashFlags(suffix: readonly string[]): boolean {
  for (const arg of suffix) {
    if (arg === "--") return false;
    if (isVarAssignment(arg)) continue;
    if (arg.startsWith("-")) return true;
  }
  return false;
}

function withWrap(ctx: Ctx, name: string): Ctx {
  return { ...ctx, wrapChain: [...ctx.wrapChain, name] };
}

function slice(ctx: Ctx, node: { pos: number; end: number }): string {
  return ctx.source.slice(node.pos, node.end);
}

function walkWord(word: Word | undefined, ctx: Ctx, frame: Frame): void {
  if (word === undefined) return;
  walkParts(word.parts, ctx, frame);
}

function walkAssignment(prefix: AssignmentPrefix, ctx: Ctx, frame: Frame): void {
  walkWord(prefix.value, ctx, frame);
  if (prefix.array !== undefined) {
    for (const word of prefix.array) walkWord(word, ctx, frame);
  }
  walkParts(prefix.indexParts, ctx, frame);
}

function walkRedirect(redirect: Redirect, ctx: Ctx, frame: Frame): void {
  walkWord(redirect.target, ctx, frame);
  walkWord(redirect.body, ctx, frame);
}

function walkParts(parts: readonly WordPart[] | undefined, ctx: Ctx, frame: Frame): void {
  if (parts === undefined) return;
  for (const part of parts) {
    switch (part.type) {
      case "DoubleQuoted":
      case "LocaleString":
        walkParts(part.parts, ctx, frame);
        break;
      case "CommandExpansion":
      case "ProcessSubstitution":
        if (part.script !== undefined) {
          walkScript(part.script, ctx, { background: false, stdinIsPipe: false, redirects: [] });
        }
        break;
      case "ParameterExpansion":
        walkWord(part.operand, ctx, frame);
        walkParts(part.indexParts, ctx, frame);
        if (part.slice !== undefined) {
          walkWord(part.slice.offset, ctx, frame);
          walkWord(part.slice.length, ctx, frame);
        }
        if (part.replace !== undefined) {
          walkWord(part.replace.pattern, ctx, frame);
          walkWord(part.replace.replacement, ctx, frame);
        }
        break;
      case "ArithmeticExpansion":
        walkArith(part.expression, ctx, frame);
        break;
      case "BraceExpansion":
      case "ExtendedGlob":
        walkParts(part.parts, ctx, frame);
        break;
      default:
        break;
    }
  }
}

function walkArith(expr: ArithmeticExpression | undefined, ctx: Ctx, frame: Frame): void {
  if (expr === undefined) return;
  switch (expr.type) {
    case "ArithmeticBinary":
      walkArith(expr.left, ctx, frame);
      walkArith(expr.right, ctx, frame);
      return;
    case "ArithmeticUnary":
      walkArith(expr.operand, ctx, frame);
      return;
    case "ArithmeticTernary":
      walkArith(expr.test, ctx, frame);
      walkArith(expr.consequent, ctx, frame);
      walkArith(expr.alternate, ctx, frame);
      return;
    case "ArithmeticGroup":
      walkArith(expr.expression, ctx, frame);
      return;
    case "ArithmeticWord":
      walkParts(expr.parts, ctx, frame);
      return;
    case "ArithmeticCommandExpansion":
      if (expr.script !== undefined) {
        walkScript(expr.script, ctx, { background: false, stdinIsPipe: false, redirects: [] });
      }
      return;
  }
}

function walkTestWords(expr: TestExpression, ctx: Ctx, frame: Frame): void {
  switch (expr.type) {
    case "TestUnary":
      walkWord(expr.operand, ctx, frame);
      return;
    case "TestBinary":
      walkWord(expr.left, ctx, frame);
      walkWord(expr.right, ctx, frame);
      return;
    case "TestLogical":
      walkTestWords(expr.left, ctx, frame);
      walkTestWords(expr.right, ctx, frame);
      return;
    case "TestNot":
      walkTestWords(expr.operand, ctx, frame);
      return;
    case "TestGroup":
      walkTestWords(expr.expression, ctx, frame);
      return;
  }
}
