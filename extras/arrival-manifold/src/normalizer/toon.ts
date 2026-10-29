/**
 * Strict TOON (Token-Oriented Object Notation) decoder.
 *
 * Spec implemented: TOON spec v3.3 (Working Draft, 2026-05-21)
 * https://github.com/toon-format/spec/blob/main/SPEC.md
 * (mirror/overview: https://github.com/toon-format/toon, https://toonformat.dev/)
 *
 * Design law: strict-or-refuse (response-normalizer.md §3.5 "inferred zone" recognizer,
 * §4.2 TOON bullet, §4.1 precision-tier precedent). This is a *recognizer* in the reach
 * tier: it either decodes a document that is unambiguously TOON, or refuses. It never
 * guesses, never salvages a prefix, and never fabricates a value the input didn't carry.
 *
 * HARD GATES (non-negotiable, per the audit that produced this module):
 *   1. A tabular/primitive array's declared `[N]` MUST equal the actual observed element
 *      count exactly. A mismatch (either direction) means the input is not TOON, or is
 *      truncated tool output — refuse either way. This is the gate that prevents a
 *      truncated response from silently parsing as a shorter, "valid" table.
 *   2. Every tabular row's field count MUST equal the header's declared arity `{f1,f2,…}`.
 *   3. The whole string must parse. No partial/prefix salvage. Trailing unconsumed content
 *      is a refusal, not a "best effort" result. (Prose+TOON mixes are the envelope
 *      recognizer's job upstream — see response-normalizer.md §4.2 "prose + end-anchored
 *      embedded STRUCTURE" — not this parser's.)
 *   4. When in doubt, refuse. See "Scope decision" below for how this is applied to
 *      scalar-only documents.
 *
 * SCOPE — implemented subset of the spec:
 *   - Root forms: an object of `key: value` fields, OR a single root-level array
 *     (`[N]{f1,f2}:` tabular, or `[N]: v1,v2` primitive) with no wrapping key.
 *   - Object scalar fields: `key: value`, value is a quoted or bare scalar
 *     (string / number / boolean / null).
 *   - Exactly ONE level of nested object: `key:` on its own line, followed by an indented
 *     block of scalar `key: value` fields (§12 indentation; hard-coded 2-space unit — see
 *     "Indentation" below). A nested object's fields must themselves be scalars: no arrays,
 *     no further nesting inside it.
 *   - Tabular arrays (§9.3): `key[N<delim?>]{f1,f2,…}:` header + N indented rows of
 *     delimiter-separated values, at top level or as an object field.
 *   - Primitive (inline) arrays (§9.1): `key[N<delim?>]: v1,v2,…` on a single line.
 *   - Delimiters (§11): comma (default, no symbol), tab, or pipe (`|`), as declared in the
 *     header's `[N<delim>]` bracket segment.
 *   - Quoting/escaping (§7.1, §7.2): double-quoted values with `\\`, `\"`, `\n`, `\r`, `\t`,
 *     `\uXXXX` escapes; a value that structurally requires quoting (contains the active
 *     delimiter, a colon, brackets/braces, control chars, leading/trailing whitespace, a
 *     leading hyphen that isn't a valid number, or the literal words `true`/`false`/`null`)
 *     but arrives unquoted is refused, not silently accepted — an unquoted value that
 *     *should* have been quoted is evidence of drift/corruption, not merely stylistic.
 *
 * REFUSED BY DESIGN (explicit, not a coverage gap):
 *   - Expanded / list-style arrays (`- ` bullet items, spec §9.4 / §10). These are a second,
 *     structurally different array encoding; supporting them doubles the row-consumption
 *     logic for a form that duplicates what the tabular form already covers for this
 *     module's purpose (array-of-uniform-records).
 *   - Nesting deeper than one level (a `key:` block inside a `key:` block, or an array
 *     nested inside a nested object). The tokenizer hard-refuses any indentation other than
 *     0 or 2 spaces, so this is caught structurally, not by depth bookkeeping.
 *   - Quoted / non-identifier object or field keys. Keys must match
 *     `^[A-Za-z_][A-Za-z0-9_.]*$` unquoted; a line that doesn't fit this (or the array
 *     header) shape is "unrecognized construct" — refuse.
 *   - Path expansion (`expandPaths`, §13.4) — an opt-in encoder feature; dotted keys are
 *     simply treated as literal key text, never split/merged.
 *   - A "document delimiter" other than comma for bare object-field scalar quoting
 *     decisions (§11.1) — only array/tabular cells honor a declared alternate delimiter.
 *
 * Scope decision — scalar-only ("YAML-lookalike") documents are REFUSED, not decoded.
 *   Per spec §5 (root-form detection), a document of nothing but `key: value` lines *is*
 *   valid TOON (it decodes to a plain object) — TOON's non-tabular form is deliberately
 *   YAML-shaped. But this module exists as a *recognizer* inside an expert system whose
 *   entire justification is structural evidence a shape genuinely is TOON and not
 *   incidental prose (response-normalizer.md §4.1's CSV identifier-plausibility guard is
 *   the sibling precedent: header-plausibility + row-count alone was still not enough
 *   evidence). A scalar-only `key: value` block is *indistinguishable* from a plain YAML
 *   snippet or a bulleted status readout with zero of the signal this format is actually
 *   about (the tabular/array density that motivated TOON's own existence — see
 *   response-normalizer.md §4.2: "decode to array-of-records like CSV"). HARD GATE 4 above
 *   ("plain YAML-ish or markdown text must not accidentally parse") is explicit about this
 *   exact case. So: this parser requires at least one array construct (`[N]{…}:` or
 *   `[N]:`) to appear somewhere in the document before it will call anything TOON; a
 *   document with zero array evidence is refused, even though a spec-conformant *encoder*
 *   would never emit anything else for a plain object.
 *
 * Indentation: the spec allows a configurable indent unit (default 2, §12). This module
 * hard-codes indentSize=2 (matching every example in the spec) and refuses any line whose
 * indentation is not exactly 0 or 2 spaces — which
 * doubles as the nesting-depth bound above. Tabs in indentation are always refused (§12).
 */

import type { ParseOutcome } from "./json.js";

const FORMAT = "toon";

class ToonRefusal extends Error {}

/** One physical, already-normalized source line. */
interface Line {
  /** Leading-space count: always 0 or 2 (enforced at tokenization time). */
  indent: number;
  /** Line content with indentation stripped and trailing whitespace trimmed. */
  text: string;
  /** Original raw line, for error messages. */
  raw: string;
}

interface HeaderInfo {
  /** Field key for an object-field array; undefined for a root-level array header. */
  key: string | undefined;
  length: number;
  delim: string;
  /** Remainder of the line after the `]`/delimiter-symbol/`]` bracket segment. */
  rest: string;
}

const HEADER_RE = /^([A-Z_][\w.]*)?\[(0|[1-9]\d*)([\t|])?\]/i;
const SCALAR_KEY_RE = /^([A-Z_][\w.]*):(.*)$/i;
const IDENT_RE = /^[A-Z_][\w.]*$/i;
const NUMBER_RE = /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i;

/** Bounds-checked array access — honest runtime guard, not a cast, for noUncheckedIndexedAccess. */
function at<T>(arr: readonly T[], i: number): T {
  const v = arr[i];
  if (v === undefined) {
    throw new ToonRefusal("internal: index out of range while parsing");
  }
  return v;
}

export function parseToonStrict(input: string): ParseOutcome {
  try {
    const value = parseDocument(input);
    return { ok: true, value, format: FORMAT };
  } catch (error) {
    if (error instanceof ToonRefusal) {
      return { ok: false, reason: error.message };
    }
    return {
      ok: false,
      reason: `internal TOON parser error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function parseDocument(input: string): unknown {
  const normalized = input.replaceAll("\r\n", "\n");
  if (normalized.trim() === "") {
    throw new ToonRefusal("empty input is not TOON");
  }
  const lines = tokenizeLines(normalized);
  const first = at(lines, 0);
  if (first.indent !== 0) {
    throw new ToonRefusal("document must not begin with indentation");
  }

  if (first.text.startsWith("[")) {
    const header = tryParseHeader(first.text);
    if (!header || header.key !== undefined) {
      throw new ToonRefusal("malformed root array header");
    }
    const { value, next } = consumeArrayBody(lines, 0, header);
    if (next !== lines.length) {
      throw new ToonRefusal("trailing content after root-level array (whole-document parse required)");
    }
    return value;
  }

  const { obj, next, hasArray } = parseRootObject(lines, 0);
  if (next !== lines.length) {
    const line = next < lines.length ? at(lines, next) : undefined;
    const rawSuffix = line ? `: ${JSON.stringify(line.raw)}` : "";
    throw new ToonRefusal(
      `orphaned or unattached content at line ${next + 1}${rawSuffix} (whole-document parse required)`,
    );
  }
  if (!hasArray) {
    throw new ToonRefusal(
      "no tabular/array construct ([N]{...}: or [N]:) found anywhere in the document — a scalar-only " +
        "key:value block is structurally indistinguishable from plain YAML/prose and is refused by design " +
        "(see the module header comment 'Scope decision'; mirrors the CSV recognizer's identifier-" +
        "plausibility guard, response-normalizer.md §4.1)",
    );
  }
  return obj;
}

function tokenizeLines(s: string): Line[] {
  let rawLines = s.split("\n");
  if (rawLines.length > 0 && at(rawLines, rawLines.length - 1) === "") {
    rawLines = rawLines.slice(0, -1);
  }
  const lines: Line[] = [];
  for (const raw of rawLines) {
    let indent = 0;
    while (indent < raw.length && raw.charAt(indent) === " ") indent++;
    if (raw.charAt(indent) === "\t") {
      throw new ToonRefusal("tab characters are not permitted in indentation (spec §12)");
    }
    const text = raw.slice(indent).trimEnd();
    if (text === "") {
      throw new ToonRefusal("blank lines are not permitted");
    }
    if (indent !== 0 && indent !== 2) {
      throw new ToonRefusal(
        `unsupported indentation (${indent} spaces) — this parser supports only 0 or 2 spaces ` +
          `(a single nesting level); see module header 'Indentation'`,
      );
    }
    lines.push({ indent, text, raw });
  }
  if (lines.length === 0) {
    throw new ToonRefusal("empty input is not TOON");
  }
  return lines;
}

function tryParseHeader(text: string): HeaderInfo | null {
  const m = HEADER_RE.exec(text);
  if (!m) return null;
  const key = m[1];
  const lengthStr = m[2];
  const delimSym = m[3];
  if (lengthStr === undefined) {
    throw new ToonRefusal("internal: malformed header match");
  }
  const full = m[0];
  if (full === undefined) {
    throw new ToonRefusal("internal: malformed header match");
  }
  const delim = delimSym === "\t" ? "\t" : delimSym === "|" ? "|" : ",";
  return { key, length: Number(lengthStr), delim, rest: text.slice(full.length) };
}

function matchScalarKeyLine(text: string): { key: string; rest: string } | null {
  const m = SCALAR_KEY_RE.exec(text);
  if (!m) return null;
  const key = m[1];
  const rest = m[2];
  if (key === undefined || rest === undefined) return null;
  return { key, rest };
}

/**
 * Consumes an array construct (tabular or primitive) starting at header line `lines[i]`.
 * Returns the decoded value and the index of the first unconsumed line.
 */
function consumeArrayBody(lines: Line[], i: number, header: HeaderInfo): { value: unknown; next: number } {
  const headerLine = at(lines, i);
  const headerDepth = headerLine.indent;
  const rowDepth = headerDepth + 2;
  const rest = header.rest;

  if (rest.startsWith("{")) {
    const closeIdx = rest.indexOf("}");
    if (closeIdx === -1) {
      throw new ToonRefusal("malformed tabular header: missing closing '}'");
    }
    const fieldsPart = rest.slice(1, closeIdx);
    const afterBrace = rest.slice(closeIdx + 1);
    if (afterBrace !== ":") {
      throw new ToonRefusal(
        "malformed tabular header: content between '}' and ':' is not permitted, and nothing may follow ':'",
      );
    }
    const fieldNames = splitDelimAware(fieldsPart, header.delim);
    if (!fieldNames || fieldNames.length === 0) {
      throw new ToonRefusal("malformed tabular header field list");
    }
    for (const f of fieldNames) {
      if (!IDENT_RE.test(f)) {
        throw new ToonRefusal(
          `invalid field name ${JSON.stringify(f)} in tabular header (quoted/non-identifier field names ` +
            `are not supported by this parser)`,
        );
      }
    }
    if (new Set(fieldNames).size !== fieldNames.length) {
      throw new ToonRefusal("duplicate field name in tabular header");
    }

    const rows: Record<string, unknown>[] = [];
    let j = i + 1;
    while (j < lines.length && at(lines, j).indent === rowDepth) {
      const rowLine = at(lines, j);
      const cells = splitDelimAware(rowLine.text, header.delim);
      if (!cells) {
        throw new ToonRefusal(`malformed row at line ${j + 1} (quoting error): ${JSON.stringify(rowLine.raw)}`);
      }
      if (cells.length !== fieldNames.length) {
        throw new ToonRefusal(
          `row arity mismatch at line ${j + 1}: header declares ${fieldNames.length} field(s) ` +
            `{${fieldNames.join(",")}}, row has ${cells.length} value(s)`,
        );
      }
      const rec: Record<string, unknown> = {};
      for (let k = 0; k < fieldNames.length; k++) {
        rec[at(fieldNames, k)] = parseScalarCell(at(cells, k), header.delim);
      }
      rows.push(rec);
      j++;
    }
    if (rows.length !== header.length) {
      throw new ToonRefusal(
        `declared length [${header.length}] does not match actual row count ${rows.length}${
          header.key ? ` for array "${header.key}"` : ""
        } — truncation/mismatch gate (this is the non-negotiable gate: a declared count that doesn't ` +
          `match observed rows means truncated or non-TOON input, never a shorter valid table)`,
      );
    }
    return { value: rows, next: j };
  }

  if (!rest.startsWith(":")) {
    throw new ToonRefusal("malformed array header: expected '{' (tabular) or ':' (primitive) immediately after ']'");
  }
  const inlineTrim = rest.slice(1).trim();
  if (inlineTrim === "") {
    const nextLine = i + 1 < lines.length ? at(lines, i + 1) : undefined;
    if (nextLine?.indent === rowDepth && nextLine.text.startsWith("- ")) {
      throw new ToonRefusal(
        "expanded list-style arrays ('- ' items, TOON spec §9.4/§10) are not supported by this parser " +
          "— refused by design, see module header 'REFUSED BY DESIGN'",
      );
    }
    if (header.length > 0) {
      throw new ToonRefusal(
        `declared length [${header.length}] does not match actual value count 0${
          header.key ? ` for array "${header.key}"` : ""
        }`,
      );
    }
    return { value: [], next: i + 1 };
  }
  const cells = splitDelimAware(inlineTrim, header.delim);
  if (!cells) {
    throw new ToonRefusal("malformed inline array values (quoting error)");
  }
  if (cells.length !== header.length) {
    throw new ToonRefusal(
      `declared length [${header.length}] does not match actual value count ${cells.length}${
        header.key ? ` for array "${header.key}"` : ""
      } — truncation/mismatch gate`,
    );
  }
  const values = cells.map((c) => parseScalarCell(c, header.delim));
  return { value: values, next: i + 1 };
}

function parseRootObject(
  lines: Line[],
  startIndex: number,
): { obj: Record<string, unknown>; next: number; hasArray: boolean } {
  const obj: Record<string, unknown> = {};
  const seen = new Set<string>();
  let hasArray = false;
  let i = startIndex;
  const depth = 0;
  while (i < lines.length && at(lines, i).indent === depth) {
    const line = at(lines, i);
    const text = line.text;

    const header = tryParseHeader(text);
    if (header?.key !== undefined) {
      if (seen.has(header.key)) {
        throw new ToonRefusal(`duplicate key "${header.key}"`);
      }
      seen.add(header.key);
      const { value, next } = consumeArrayBody(lines, i, header);
      obj[header.key] = value;
      i = next;
      hasArray = true;
      continue;
    }

    const kv = matchScalarKeyLine(text);
    if (kv) {
      if (seen.has(kv.key)) {
        throw new ToonRefusal(`duplicate key "${kv.key}"`);
      }
      seen.add(kv.key);
      const restTrim = kv.rest.trim();
      if (restTrim === "") {
        const nestedStart = i + 1;
        const nestedLine = nestedStart < lines.length ? at(lines, nestedStart) : undefined;
        if (nestedLine?.indent !== depth + 2) {
          throw new ToonRefusal(
            `key "${kv.key}:" declares a nested object but no indented content follows (line ${i + 1})`,
          );
        }
        const { obj: nestedObj, next } = parseNestedScalarFields(lines, nestedStart, depth + 2);
        obj[kv.key] = nestedObj;
        i = next;
        continue;
      }
      obj[kv.key] = parseScalarCell(restTrim, ",");
      i++;
      continue;
    }

    throw new ToonRefusal(`unrecognized construct at line ${i + 1}: ${JSON.stringify(line.raw)}`);
  }
  return { obj, next: i, hasArray };
}

/** One level of nested object: scalar fields only — no arrays, no further nesting. */
function parseNestedScalarFields(
  lines: Line[],
  startIndex: number,
  depth: number,
): { obj: Record<string, unknown>; next: number } {
  const obj: Record<string, unknown> = {};
  const seen = new Set<string>();
  let i = startIndex;
  while (i < lines.length && at(lines, i).indent === depth) {
    const line = at(lines, i);
    const text = line.text;

    if (tryParseHeader(text)) {
      throw new ToonRefusal(
        `array constructs are not supported inside a nested object (line ${i + 1}) — nesting depth ` +
          `bound is 1 level, see module header 'REFUSED BY DESIGN'`,
      );
    }
    const kv = matchScalarKeyLine(text);
    if (!kv) {
      throw new ToonRefusal(
        `unrecognized construct at line ${i + 1} inside nested object: ${JSON.stringify(line.raw)}`,
      );
    }
    if (seen.has(kv.key)) {
      throw new ToonRefusal(`duplicate key "${kv.key}" in nested object`);
    }
    seen.add(kv.key);
    const restTrim = kv.rest.trim();
    if (restTrim === "") {
      throw new ToonRefusal(
        `key "${kv.key}:" implies a second level of nesting (line ${i + 1}) — nesting depth bound is ` +
          `1 level, see module header 'REFUSED BY DESIGN'`,
      );
    }
    obj[kv.key] = parseScalarCell(restTrim, ",");
    i++;
  }
  return { obj, next: i };
}

/**
 * Delimiter-aware split of a single line's worth of cells, honoring double-quoted
 * segments (which may contain the delimiter, colons, etc.) per spec §7.1/§11. Returns
 * null on any quoting malformation (unterminated quote, content after a closing quote
 * before the next delimiter, a quote appearing mid-token).
 */
function splitDelimAware(text: string, delim: string): string[] | null {
  const tokens: string[] = [];
  let cur = "";
  let inQuotes = false;
  let tokenHadQuote = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text.charAt(i);
    if (inQuotes) {
      if (c === "\\") {
        if (i + 1 >= n) return null;
        cur += c + text.charAt(i + 1);
        i += 2;
        continue;
      }
      if (c === '"') {
        inQuotes = false;
        cur += c;
        i++;
        continue;
      }
      cur += c;
      i++;
      continue;
    }
    if (c === '"') {
      if (cur.length > 0) return null; // a quote may only open at the start of a token
      inQuotes = true;
      tokenHadQuote = true;
      cur += c;
      i++;
      continue;
    }
    if (c === delim) {
      tokens.push(cur);
      cur = "";
      tokenHadQuote = false;
      i++;
      continue;
    }
    if (tokenHadQuote) return null; // trailing content after a closing quote, before the delimiter
    cur += c;
    i++;
  }
  if (inQuotes) return null; // unterminated quoted value
  tokens.push(cur);
  return tokens;
}

/** Decodes one already-isolated cell/scalar token into its JS value, or refuses. */
function parseScalarCell(token: string, delim: string): unknown {
  if (token.length >= 2 && token.charAt(0) === '"' && token.at(-1) === '"') {
    return unescapeQuoted(token.slice(1, -1));
  }
  if (token.startsWith('"')) {
    throw new ToonRefusal(`unterminated or malformed quoted value: ${JSON.stringify(token)}`);
  }
  if (token === "") {
    throw new ToonRefusal("empty unquoted value (spec requires empty strings to be quoted, §7.2)");
  }
  if (token === "true") return true;
  if (token === "false") return false;
  if (token === "null") return null;
  if (NUMBER_RE.test(token)) return Number(token);

  if (/["\\[\]{}:]/.test(token)) {
    throw new ToonRefusal(`unquoted value contains a character that requires quoting (§7.2): ${JSON.stringify(token)}`);
  }
  if (token.includes(delim)) {
    throw new ToonRefusal(`unquoted value contains the active delimiter and must be quoted: ${JSON.stringify(token)}`);
  }
  if (/^\s|\s$/.test(token)) {
    throw new ToonRefusal(
      `unquoted value has leading/trailing whitespace and must be quoted: ${JSON.stringify(token)}`,
    );
  }
  if (token.charAt(0) === "-") {
    throw new ToonRefusal(
      `unquoted value starting with '-' must be quoted (or be a valid number): ${JSON.stringify(token)}`,
    );
  }

  if (/[\u0000-\u001F]/.test(token)) {
    throw new ToonRefusal("unquoted value contains a control character");
  }
  return token;
}

function unescapeQuoted(inner: string): string {
  let out = "";
  let i = 0;
  const n = inner.length;
  while (i < n) {
    const c = inner.charAt(i);
    if (c === "\\") {
      const next = inner.charAt(i + 1);
      switch (next) {
        case "\\":
          out += "\\";
          i += 2;
          break;
        case '"':
          out += '"';
          i += 2;
          break;
        case "n":
          out += "\n";
          i += 2;
          break;
        case "r":
          out += "\r";
          i += 2;
          break;
        case "t":
          out += "\t";
          i += 2;
          break;
        case "u": {
          const hex = inner.slice(i + 2, i + 6);
          if (!/^[0-9a-f]{4}$/i.test(hex)) {
            throw new ToonRefusal(String.raw`invalid \u escape in quoted value`);
          }
          out += String.fromCodePoint(Number.parseInt(hex, 16));
          i += 6;
          break;
        }
        default:
          throw new ToonRefusal(`invalid escape sequence "\\${next}" in quoted value (spec §7.1)`);
      }
    } else {
      out += c;
      i++;
    }
  }
  return out;
}
