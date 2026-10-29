/**
 * Statement units for Tirith. Unbash AST, not regex. A pipeline of
 * `grep 'fn()' file | head` is two commands; Tirith's nested-body
 * analyzer treats the `|` as "the RHS might execute the LHS" and
 * fail-closes. Dropping a proven-pure tail and checking each
 * statement separately is the host's claim, not Tirith's.
 *
 * Do not peel when a function, `source`/`.`/`eval`/`alias`, or a
 * PATH/ENV assignment is in the script: those rebind the tail name
 * for later stages. Parse failure keeps the original line.
 */
import { parse, type Command, type Node, type Statement, type Word, type WordPart } from "unbash";

const SAFE_TAILS: ReadonlySet<string> = new Set([
  "head",
  "tail",
  "wc",
  "uniq",
  "sort",
  "cut",
  "tr",
  "cat",
  "true",
  "false",
]);

const SEAL_NAMES: ReadonlySet<string> = new Set(["source", ".", "eval", "alias"]);
const IDENTITY_VARS: ReadonlySet<string> = new Set(["PATH", "ENV", "BASH_ENV"]);
const PARTLESS_FORBIDDEN = /[*?[\\$`]/;

export function tirithUnits(source: string): readonly string[] {
  const script = parse(source);
  if (script.errors !== undefined && script.errors.length > 0) return [source];
  if (script.commands.some(sealsNode)) return [source];
  if (!script.commands.some(hasMultiStagePipe)) return [source];
  const units: string[] = [];
  for (const statement of script.commands) collectStatement(statement, source, units);
  return units.length === 0 ? [source] : units;
}

function collectStatement(statement: Statement, source: string, units: string[]): void {
  if (statement.redirects.length > 0) {
    units.push(source.slice(statement.command.pos, statement.command.end));
    return;
  }
  collectNode(statement.command, source, units);
}

function collectNode(node: Node, source: string, units: string[]): void {
  switch (node.type) {
    case "Statement":
      collectStatement(node, source, units);
      return;
    case "CompoundList":
      for (const statement of node.commands) collectStatement(statement, source, units);
      return;
    case "Pipeline":
      units.push(peelPipeline(node, source));
      return;
    case "AndOr":
      for (const child of node.commands) collectNode(child, source, units);
      return;
    case "Subshell":
    case "BraceGroup":
      collectNode(node.body, source, units);
      return;
    case "If":
      collectNode(node.clause, source, units);
      collectNode(node.then, source, units);
      if (node.else !== undefined) collectNode(node.else, source, units);
      return;
    case "For":
    case "Select":
      collectNode(node.body, source, units);
      return;
    case "ArithmeticFor":
    case "While":
      collectNode(node.body, source, units);
      return;
    case "Case":
      for (const item of node.items) collectNode(item.body, source, units);
      return;
    case "Command":
    case "TestCommand":
    case "ArithmeticCommand":
      units.push(source.slice(node.pos, node.end));
      return;
    case "Function":
    case "Coproc":
      units.push(source.slice(node.pos, node.end));
      return;
  }
}

function peelPipeline(node: Extract<Node, { type: "Pipeline" }>, source: string): string {
  let keep = node.commands.length;
  while (keep > 1 && node.operators[keep - 2] === "|" && isSafeTail(node.commands[keep - 1])) {
    keep -= 1;
  }
  if (keep === node.commands.length) return source.slice(node.pos, node.end);
  return source.slice(node.pos, node.commands[keep - 1].end);
}

function isSafeTail(node: Node): boolean {
  if (node.type === "Pipeline" && node.commands.length === 1 && node.negated !== true && node.time !== true) {
    return isSafeTail(node.commands[0]);
  }
  if (node.type !== "Command") return false;
  if (node.redirects.length > 0 || node.prefix.length > 0 || node.name === undefined) return false;
  if (!isLiteralWord(node.name) || node.name.value.includes("/")) return false;
  const argv0 = node.name.value;
  if (!SAFE_TAILS.has(argv0)) return false;
  return argv0 !== "sort" || !sortWrites(node);
}

function sortWrites(command: Command): boolean {
  for (const word of command.suffix) {
    if (!isLiteralWord(word)) return true;
    const value = word.value;
    if (value.startsWith("-o") || value === "--output" || value.startsWith("--output=")) return true;
  }
  return false;
}

function hasMultiStagePipe(node: Node): boolean {
  switch (node.type) {
    case "Pipeline":
      return node.commands.length > 1 || node.commands.some(hasMultiStagePipe);
    case "Statement":
      return hasMultiStagePipe(node.command);
    case "CompoundList":
      return node.commands.some(hasMultiStagePipe);
    case "AndOr":
      return node.commands.some(hasMultiStagePipe);
    case "Subshell":
    case "BraceGroup":
      return hasMultiStagePipe(node.body);
    case "If":
      return (
        hasMultiStagePipe(node.clause) ||
        hasMultiStagePipe(node.then) ||
        (node.else !== undefined && hasMultiStagePipe(node.else))
      );
    case "For":
    case "Select":
    case "While":
    case "ArithmeticFor":
      return hasMultiStagePipe(node.body);
    case "Case":
      return node.items.some((item) => hasMultiStagePipe(item.body));
    case "Function":
    case "Coproc":
    case "Command":
    case "TestCommand":
    case "ArithmeticCommand":
      return false;
  }
}

function sealsNode(node: Node): boolean {
  switch (node.type) {
    case "Function":
    case "Coproc":
      return true;
    case "Statement":
      return sealsNode(node.command);
    case "CompoundList":
      return node.commands.some(sealsNode);
    case "Pipeline":
    case "AndOr":
      return node.commands.some(sealsNode);
    case "Subshell":
    case "BraceGroup":
      return sealsNode(node.body);
    case "If":
      return sealsNode(node.clause) || sealsNode(node.then) || (node.else !== undefined && sealsNode(node.else));
    case "For":
    case "Select":
    case "While":
    case "ArithmeticFor":
      return sealsNode(node.body);
    case "Case":
      return node.items.some((item) => sealsNode(item.body));
    case "Command":
      return commandSeals(node);
    case "TestCommand":
    case "ArithmeticCommand":
      return false;
  }
}

function commandSeals(command: Command): boolean {
  if (command.prefix.some((prefix) => prefix.name !== undefined && IDENTITY_VARS.has(prefix.name))) return true;
  if (command.name === undefined || !isLiteralWord(command.name)) return false;
  if (SEAL_NAMES.has(command.name.value)) return true;
  if (command.name.value !== "export") return false;
  return command.suffix.some((word) => {
    const eq = word.value.indexOf("=");
    return eq > 0 && IDENTITY_VARS.has(word.value.slice(0, eq));
  });
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
