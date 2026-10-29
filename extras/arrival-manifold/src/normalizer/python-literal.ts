// python-literal — strict recursive-descent parser for the Python `repr(dict)`/`str(dict)`
// grammar subset that leaks out of Python MCP servers (FastMCP/click/argparse-backed) when a
// handler serializes its response with `str()` instead of `json.dumps()`. Systemic on
// airflow (every module), and seen on excel, ros2, tinybird. The parser accepts an audit-ratified subset and exists to protect the round-trip law:
// `serialize(parse(s)) ≈ s` (up to insignificant whitespace — no key reorder, no number
// reformat). This is NOT `eval()` and NOT a general Python literal evaluator: every refusal
// below is a specific held-out failure this file is designed to never repeat.
//
// Strict-or-refuse. A rejected parse costs nothing (the caller keeps the raw string); a loose
// accept silently rewrites the payload, which is corruption, not recovery. Two refusal classes
// carry this weight and must fire at ANY nesting depth, not just top-level:
//   - tuples (`(1, 2)`) — Python re-serializes them as a JSON array; the parenthesized identity
//     is lost, so accepting one and reporting it back as a list is exactly the round-trip
//     violation this parser must never commit.
//   - sets (`{1, 2}`) and non-string dict keys (`{1: 2}`) — neither has a faithful JSON
//     encoding; guessing one invents information that was never in the payload.
// A bare top-level scalar (`None`, `True`, `123`, `'hello'`) is refused too, but for a
// different reason: a bare `None` is frequently a legitimate empty-cell readout (the excel
// server that motivated this file emits exactly that), and silently promoting it to JSON
// `null` at the container boundary would misrepresent an intentional single value as "there
// is nothing here." Only dict/list containers are accepted at the top.
//
// JSON-overlap decision (required by the accept/refuse contract, tested below): some inputs
// are simultaneously valid JSON and valid Python-literal syntax — a double-quoted string is a
// legal Python string too, and a bare integer/float reads identically in both grammars. This
// parser ACCEPTS that overlap (format stays "python-literal", value is identical either way —
// there is no ambiguity to resolve and no extra detection logic is worth adding just to refuse
// something harmless). What it does NOT accept is JSON's *spelling* of booleans/null —
// lowercase `true`/`false`/`null` are not Python identifiers (`str(dict)` never emits them;
// Python's are `True`/`False`/`None`), so they fall outside this grammar on their own. Rather
// than let that surface as a generic "unrecognized token", the keyword scanner recognizes the
// JSON spelling specifically and refuses with a message that redirects to the JSON parser —
// satisfying the "or refuse and point at JSON" half of the decision for exactly the part of
// the overlap where the spellings genuinely diverge.

// The shared normalizer contract: a strict parser either produces a value under a named
// format, or refuses with a human-readable reason — never a partial/best-effort value.
// `./json.ts` (the normalizer's JSON recognizer) owns the canonical definition; imported
// here rather than redefined, so every recognizer shares one contract.
import type { ParseOutcome } from "./json.js";

const FORMAT = "python-literal";

/** Internal control-flow signal only — never escapes `parsePythonLiteralStrict`. */
class Refusal extends Error {
  constructor(public readonly reason: string) {
    super(reason);
  }
}

type Kind = "dict" | "list" | "string" | "number" | "bool" | "null";
interface Parsed {
  kind: Kind;
  value: unknown;
}

// Plain `boolean` returns, deliberately not `c is string` type predicates: these test a
// *range* of characters, not a single literal, so a `c is string` predicate would make TS
// narrow the negative branch to `undefined` (wrongly implying "not alpha" means "not a
// string at all") and produce a false "always false" downstream comparison.
function isDigit(c: string | undefined): boolean {
  return c !== undefined && c >= "0" && c <= "9";
}

function isAlpha(c: string | undefined): boolean {
  return c !== undefined && ((c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_");
}

function isAlnum(c: string | undefined): boolean {
  return isAlpha(c) || isDigit(c);
}

/** Single-char Python string-literal prefixes (and their two-char raw-string combinations)
 *  that precede a quote without a space: `b'..'`, `f'..'`, `rb'..'`, etc. None of these are a
 *  plain string literal — refused explicitly rather than falling through to a generic
 *  "unrecognized token". */
const STRING_PREFIXES = new Set([
  "b",
  "B",
  "f",
  "F",
  "r",
  "R",
  "u",
  "U",
  "rb",
  "Rb",
  "rB",
  "RB",
  "br",
  "Br",
  "bR",
  "BR",
  "fr",
  "Fr",
  "fR",
  "FR",
  "rf",
  "Rf",
  "rF",
  "RF",
]);

const JSON_LOWERCASE_LITERALS = new Set(["true", "false", "null"]);

class Cursor {
  pos = 0;
  constructor(public readonly s: string) {}

  // Deliberately a method, not a `get eof()` accessor: TS's control-flow narrowing treats a
  // getter's result as stable across an intervening mutating call (`next()` advances `pos`),
  // which produced a false "always falsy" `no-unnecessary-condition` lint at the second of two
  // eof checks separated by a `next()` call. A method call isn't narrowed the same way.
  atEof(): boolean {
    return this.pos >= this.s.length;
  }

  peek(): string | undefined {
    return this.s[this.pos];
  }

  next(): string {
    const c = this.s[this.pos];
    if (c === undefined) throw new Refusal("refuse: unexpected end of input");
    this.pos++;
    return c;
  }

  skipWs(): void {
    for (;;) {
      const c = this.s[this.pos];
      if (c === " " || c === "\t" || c === "\n" || c === "\r") this.pos++;
      else break;
    }
  }
}

function parseString(cur: Cursor): Parsed {
  const quote = cur.next(); // ' or "
  let out = "";
  for (;;) {
    if (cur.atEof()) throw new Refusal("refuse unterminated string literal");
    const c = cur.next();
    if (c === quote) return { kind: "string", value: out };
    if (c === "\\") {
      if (cur.atEof()) throw new Refusal("refuse unterminated string literal (trailing backslash)");
      const esc = cur.next();
      switch (esc) {
        case "'":
          out += "'";
          break;
        case '"':
          out += '"';
          break;
        case "\\":
          out += "\\";
          break;
        case "n":
          out += "\n";
          break;
        case "t":
          out += "\t";
          break;
        default:
          throw new Refusal(`refuse unsupported string escape '\\${esc}' — only \\' \\" \\\\ \\n \\t are recognized`);
      }
      continue;
    }
    out += c;
  }
}

/** Consumes one-or-more digits at the cursor, or refuses — the shared "at least one digit
 *  here" requirement for the integer part, the fractional part, and the exponent part. */
function consumeDigitRun(cur: Cursor, start: number, whatFor: string): void {
  if (!isDigit(cur.peek())) throw new Refusal(`refuse invalid number literal (${whatFor}) at position ${start}`);
  while (isDigit(cur.peek())) cur.pos++;
}

function parseNumber(cur: Cursor): Parsed {
  const start = cur.pos;
  if (cur.peek() === "-") cur.pos++;
  consumeDigitRun(cur, start, "integer part");

  if (cur.peek() === ".") {
    cur.pos++;
    consumeDigitRun(cur, start, "missing digits after '.'");
  }
  if (cur.peek() === "e" || cur.peek() === "E") {
    cur.pos++;
    if (cur.peek() === "+" || cur.peek() === "-") cur.pos++;
    consumeDigitRun(cur, start, "malformed exponent");
  }

  const text = cur.s.slice(start, cur.pos);
  const n = Number(text);
  if (!Number.isFinite(n)) throw new Refusal(`refuse invalid number literal '${text}'`);
  return { kind: "number", value: n };
}

/** Reads `True`/`False`/`None`, refuses the JSON-spelled equivalents by name, refuses
 *  string-literal prefixes (`b'..'`, `f'..'`) and constructor/function reprs
 *  (`datetime.datetime(...)`) by name, and falls back to a generic unrecognized-token refusal
 *  for anything else (bare identifiers, comprehension variables, etc). */
function parseKeyword(cur: Cursor): Parsed {
  const start = cur.pos;
  while (isAlnum(cur.peek())) cur.pos++;
  const ident = cur.s.slice(start, cur.pos);

  if (ident === "True") return { kind: "bool", value: true };
  if (ident === "False") return { kind: "bool", value: false };
  if (ident === "None") return { kind: "null", value: null };

  if (JSON_LOWERCASE_LITERALS.has(ident)) {
    throw new Refusal(
      `refuse JSON-spelled literal '${ident}' — python-literal requires 'True'/'False'/'None'; ` +
        "this input looks like JSON, use the JSON parser instead",
    );
  }

  const nextChar = cur.peek();
  if ((nextChar === "'" || nextChar === '"') && STRING_PREFIXES.has(ident)) {
    throw new Refusal(
      `refuse python string-prefix literal '${ident}${nextChar}...' (bytes/f-string/raw-string) ` +
        "— not a plain string literal",
    );
  }
  if (nextChar === "(" || nextChar === ".") {
    throw new Refusal(
      `refuse constructor/function repr '${ident}...' (e.g. datetime.datetime(...)) ` + "— repr leakage, not a literal",
    );
  }
  throw new Refusal(`refuse unrecognized token '${ident}' at position ${start}`);
}

/** `{` opens either a dict (string key, `:`, value) or a Python set (bare comma-separated
 *  elements) — the two are disambiguated by whether a `:` follows the first element, exactly
 *  as Python's own grammar does. `{}` is always the empty dict (Python has no empty-set
 *  literal). Both the set refusal and the non-string-key refusal fire from inside this
 *  function, which is called recursively for every nested `{...}` — so both refusals are
 *  automatically depth-agnostic without any explicit depth bookkeeping. */
function parseDictOrSet(cur: Cursor): Parsed {
  cur.next(); // consume '{'
  cur.skipWs();
  const obj: Record<string, unknown> = {};
  if (cur.peek() === "}") {
    cur.next();
    return { kind: "dict", value: obj };
  }

  let sawEntry = false;
  for (;;) {
    const key = parseValue(cur);
    cur.skipWs();
    if (cur.peek() !== ":") {
      throw new Refusal(
        sawEntry
          ? `refuse malformed dict — expected ':' after key at position ${cur.pos}`
          : "refuse set literal — sets don't round-trip and aren't JSON-representable",
      );
    }
    if (key.kind !== "string") {
      throw new Refusal(
        `refuse non-string dict key (kind: ${key.kind}) — dict keys must be single- or double-quoted strings`,
      );
    }
    cur.next(); // consume ':'
    const value = parseValue(cur);
    obj[key.value as string] = value.value;
    sawEntry = true;

    cur.skipWs();
    const nc = cur.peek();
    if (nc === ",") {
      cur.next();
      cur.skipWs();
      continue;
    }
    if (nc === "}") {
      cur.next();
      return { kind: "dict", value: obj };
    }
    throw new Refusal(`refuse malformed dict — expected ',' or '}' at position ${cur.pos}`);
  }
}

function parseList(cur: Cursor): Parsed {
  cur.next(); // consume '['
  cur.skipWs();
  const arr: unknown[] = [];
  if (cur.peek() === "]") {
    cur.next();
    return { kind: "list", value: arr };
  }
  for (;;) {
    const v = parseValue(cur);
    arr.push(v.value);
    cur.skipWs();
    const nc = cur.peek();
    if (nc === ",") {
      cur.next();
      cur.skipWs();
      continue;
    }
    if (nc === "]") {
      cur.next();
      return { kind: "list", value: arr };
    }
    throw new Refusal(`refuse malformed list — expected ',' or ']' at position ${cur.pos}`);
  }
}

/** One value in the grammar: dict, list, string, number, or the True/False/None keywords.
 *  `(` is refused immediately as a tuple — no need to parse its contents, the parenthesized
 *  form itself is the round-trip violation — which makes the tuple refusal depth-agnostic for
 *  free, the same way the set/non-string-key refusals are in `parseDictOrSet`. */
function parseValue(cur: Cursor): Parsed {
  cur.skipWs();
  if (cur.atEof()) throw new Refusal("refuse: unexpected end of input while reading a value");
  const c = cur.peek();
  if (c === "{") return parseDictOrSet(cur);
  if (c === "[") return parseList(cur);
  if (c === "(") {
    throw new Refusal("refuse tuple literal — tuples don't round-trip (would re-serialize as a list)");
  }
  if (c === "'" || c === '"') return parseString(cur);
  if (c === "-" || isDigit(c)) return parseNumber(cur);
  if (isAlpha(c)) return parseKeyword(cur);
  if (c === "<") {
    throw new Refusal(`refuse object-repr leakage (e.g. <git.Actor "x">) at position ${cur.pos} — not a literal`);
  }
  throw new Refusal(`refuse unexpected character '${String(c)}' at position ${cur.pos}`);
}

/** Parses `s` as the audit-ratified Python-literal subset: a top-level dict or list, string
 *  dict keys only, recursive tuple/set/non-string-key refusal at any depth, no eval, no
 *  partial results. See the module header for the full accept/refuse contract and the
 *  JSON-overlap decision. */
export function parsePythonLiteralStrict(s: string): ParseOutcome {
  const cur = new Cursor(s);
  try {
    cur.skipWs();
    if (cur.atEof()) return { ok: false, reason: "refuse empty input" };

    const parsed = parseValue(cur);
    if (parsed.kind !== "dict" && parsed.kind !== "list") {
      return {
        ok: false,
        reason:
          `refuse top-level scalar (${parsed.kind}) — python-literal requires a top-level ` +
          "dict or list, not a bare value",
      };
    }

    cur.skipWs();
    if (!cur.atEof()) {
      return {
        ok: false,
        reason: `refuse trailing content after the top-level literal at position ${cur.pos}`,
      };
    }

    return { ok: true, value: parsed.value, format: FORMAT };
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, reason: error.reason };
    throw error;
  }
}
