/**
 * Peel a leading cwd-only `cd` off a shell command into the `cwd` arg.
 * Unbash AST, not regex. Quoted `;` is not a splitter. Remainder stays
 * one `/bin/sh -c` — this is not execute-split.
 *
 * Peel only the first top-level list element (`&&` or `;` / newline).
 * `||`, pipes, subshells, brace groups, `cd` that is not first, and
 * `cd` with flags/extra operands stay on the command string.
 */
import { parse, type Command, type Node, type Word, type WordPart } from "unbash";

type PeeledCd = {
  readonly cwd: string;
  readonly command: string;
};

const PARTLESS_FORBIDDEN = /[*?[\\$`]/;

export function peelLeadingCd(source: string): PeeledCd | null {
  const script = parse(source);
  if (script.errors !== undefined && script.errors.length > 0) return null;
  const statements = script.commands;
  if (statements.length === 0) return null;
  const first = statements[0];
  if (first === undefined || first.background === true || first.redirects.length > 0) return null;

  const node = first.command;
  const simple = asSimpleCommand(node);
  if (simple !== null) {
    const cwd = cwdOnlyPath(simple);
    if (cwd === null) return null;
    if (statements.length === 1) return { cwd, command: "" };
    return { cwd, command: source.slice(statements[1]!.pos).trim() };
  }

  if (node.type !== "AndOr" || node.operators[0] !== "&&") return null;
  const head = asSimpleCommand(node.commands[0]);
  if (head === null) return null;
  const cwd = cwdOnlyPath(head);
  if (cwd === null) return null;
  const rest = node.commands[1];
  if (rest === undefined) return { cwd, command: "" };
  return { cwd, command: source.slice(rest.pos).trim() };
}

/** Keep an explicit `cwd` arg when it names the same leaf; never override a disagreement. */
export function peelShellCwd(command: string, cwdArg?: string): PeeledCd | null {
  const peeled = peelLeadingCd(command);
  if (peeled === null) return null;
  if (cwdArg !== undefined && cwdArg !== "" && normalizeCwdToken(cwdArg) !== normalizeCwdToken(peeled.cwd)) {
    return null;
  }
  return {
    cwd: cwdArg !== undefined && cwdArg !== "" ? cwdArg : peeled.cwd,
    command: peeled.command,
  };
}

function normalizeCwdToken(raw: string): string {
  let token = raw.replaceAll("\\", "/").replace(/\/+$/, "");
  if (token.startsWith("./")) token = token.slice(2);
  return token === "" ? "." : token;
}

function asSimpleCommand(node: Node | undefined): Command | null {
  if (node === undefined) return null;
  if (node.type === "Command") return node;
  if (node.type !== "Pipeline") return null;
  if (node.commands.length !== 1 || (node.operators?.length ?? 0) > 0) return null;
  if (node.negated === true || node.time === true) return null;
  return asSimpleCommand(node.commands[0]);
}

function cwdOnlyPath(command: Command): string | null {
  if (command.prefix.length > 0 || command.redirects.length > 0) return null;
  if (command.name === undefined || !isLiteralWord(command.name)) return null;
  let argv0 = command.name.value;
  let suffix = command.suffix;
  if (argv0 === "builtin" || argv0 === "command") {
    const inner = suffix[0];
    if (inner === undefined || !isLiteralWord(inner) || inner.value !== "cd") return null;
    argv0 = "cd";
    suffix = suffix.slice(1);
  }
  if (argv0 !== "cd" || suffix.length !== 1) return null;
  const dest = suffix[0];
  if (dest === undefined || !isLiteralWord(dest)) return null;
  const value = dest.value;
  if (value === "" || value === "-" || value === "--" || value.startsWith("-")) return null;
  return value;
}

function isLiteralWord(word: Word): boolean {
  if (word.parts === undefined) {
    return !PARTLESS_FORBIDDEN.test(word.text) && !word.text.startsWith("~");
  }
  return word.parts.every(partIsLiteral);
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
