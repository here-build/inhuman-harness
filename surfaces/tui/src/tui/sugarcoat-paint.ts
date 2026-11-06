/**
 * Tape paint for scheme_repl: sugarcoat the stored Scheme, colour with the
 * compensated-Darcula token hex from @here.build/editor-theme (theme-darcula.ts).
 * Tokenizer is the arrival-cli eject — no CodeMirror in the TUI.
 * Source and receipt classification live in `sugarcoat.ts` of `@inhuman.tools/harness-sdk/text`
 * (no quickdraw) and are re-exported here, so paint importers keep one door.
 */
import { BOOLEAN_ATOMS, type SchemePaintPart } from "@inhuman.tools/harness-sdk/text";
import type { HighlightLine, TokenRun } from "@inhuman.tools/quickdraw/widgets";

export {
  BOOLEAN_ATOMS,
  decodeDisplayString,
  fileSchemePart,
  formatSchemeResult,
  isMarkdownPath,
  schemePaintReceipt,
  sugarcoatProgram,
  sugarcoatSource,
  type FilePaintHint,
  type SchemePaintKind,
  type SchemePaintPart,
  type SchemePaintReceipt,
} from "@inhuman.tools/harness-sdk/text";

/** DARCULA_HEX — CHANGE ONLY with commons/packages/editor-theme/src/theme-darcula.ts. Local retune drifts editor vs tape. */
const DARCULA = {
  keyword: "#bb6b25",
  function: "#f8bf66",
  symbol: "#a9b5c1",
  string: "#728e60",
  number: "#5b89ad",
  constant: "#5b89ad",
  property: "#9673a7",
  comment: "#717171",
  delimiter: "#717171",
} as const;

const DEFINITION_KEYWORDS = new Set(
  `define define-values define-syntax define-macro defmacro define-class define-record-type
   define/overridable lambda λ case-lambda opt-lambda
   let let* letrec letrec-syntax let-syntax let-values let*-values let/ec let/cc
   syntax-rules syntax-case`
    .split(/\s+/)
    .filter(Boolean),
);
const CONTROL_KEYWORDS = new Set(
  `if cond when unless case else and or not begin do for-each map
   delay force dynamic-wind call/cc call-with-current-continuation
   quote quasiquote unquote unquote-splicing set! require import =>`
    .split(/\s+/)
    .filter(Boolean),
);
const DELIM = new Set(["(", ")", "[", "]", "{", "}"]);

export function highlightSchemePart(part: SchemePaintPart): HighlightLine[] {
  if (part.kind === "syntax") return highlightSugarcoat(part.text);
  if (part.kind === "number") return highlightPlain(part.text, DARCULA.number);
  if (part.kind === "boolean") return highlightPlain(part.text, DARCULA.keyword);
  return highlightPlain(part.text);
}

function highlightPlain(src: string, color?: string): HighlightLine[] {
  return src.split("\n").map((line) => (line.length > 0 ? [run(line, color)] : []));
}

function isNumber(atom: string): boolean {
  return /^[+-]?(?:\d|\.\d|#[xbodei])/i.test(atom);
}

function atomColor(atom: string): string {
  if (DEFINITION_KEYWORDS.has(atom) || CONTROL_KEYWORDS.has(atom)) return DARCULA.keyword;
  if (BOOLEAN_ATOMS.has(atom)) return DARCULA.keyword;
  if (atom === "nil") return DARCULA.constant;
  if (atom.length > 1 && atom.startsWith(":")) return DARCULA.property;
  if (atom.length > 1 && atom.startsWith(".")) return DARCULA.function;
  if (isNumber(atom)) return DARCULA.number;
  return DARCULA.symbol;
}

function run(text: string, color?: string): TokenRun {
  const next: TokenRun = { text };
  if (color) next.color = color;
  return next;
}

/** Colour sugarcoat/Scheme source. Every input byte is in some run. */
export function highlightSugarcoat(src: string): HighlightLine[] {
  const runs: TokenRun[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i]!;

    if (ch === '"') {
      let j = i + 1;
      while (j < n) {
        if (src[j] === "\\") {
          j += 2;
          continue;
        }
        if (src[j] === '"') {
          j += 1;
          break;
        }
        j += 1;
      }
      runs.push(run(src.slice(i, j), DARCULA.string));
      i = j;
      continue;
    }

    if (ch === "#" && src[i + 1] === "|") {
      const end = src.indexOf("|#", i + 2);
      const j = end === -1 ? n : end + 2;
      runs.push(run(src.slice(i, j), DARCULA.comment));
      i = j;
      continue;
    }

    if (ch === ";") {
      let j = i;
      while (j < n && src[j] !== "\n") j += 1;
      runs.push(run(src.slice(i, j), DARCULA.comment));
      i = j;
      continue;
    }

    if (DELIM.has(ch)) {
      runs.push(run(ch, DARCULA.delimiter));
      i += 1;
      continue;
    }

    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      runs.push(run(ch));
      i += 1;
      continue;
    }

    let j = i;
    while (j < n) {
      const c = src[j]!;
      if (DELIM.has(c) || c === '"' || c === ";" || c === " " || c === "\t" || c === "\n" || c === "\r") {
        break;
      }
      j += 1;
    }
    const atom = src.slice(i, j);
    runs.push(run(atom, atomColor(atom)));
    i = j;
  }
  return splitLines(runs);
}

function splitLines(runs: TokenRun[]): HighlightLine[] {
  const lines: HighlightLine[] = [[]];
  for (const token of runs) {
    const parts = token.text.split("\n");
    for (const [i, part] of parts.entries()) {
      if (i > 0) lines.push([]);
      if (part.length > 0) lines.at(-1)!.push(run(part, token.color));
    }
  }
  return lines;
}
