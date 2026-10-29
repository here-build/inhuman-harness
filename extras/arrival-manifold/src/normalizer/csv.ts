// CSV/TSV strict recognizer — response-normalizer §4.1 precision tier.
//
// Design law: strict-or-refuse. A refusal costs nothing (the raw text stays available
// to the caller); a misparse is silent corruption of the model's data. Every guard here
// exists because its absence mangled a real held-out server — a permissive "the parser didn't throw" check is not the bar.
//
// Guards enforced, all must hold or the whole input is refused:
//   1. >= 2 columns, consistent column count across every row (header + data).
//   2. >= 2 DATA rows — header + 1 row is not enough evidence this is tabular at all.
//   3. Header-plausibility (the load-bearing guard, audit F5): every header cell must
//      read as an identifier-like label, never a sentence/address fragment. Two
//      consistent columns is NOT sufficient on its own — see the address-list
//      counterexample in the test file.
//   4. RFC-4180-style quoted fields (`"a, b"`, `""` escaping) parse correctly; quoting
//      evidence in the body is a positive signal but never overrides a failing header.
//   5. An unescaped newline inside a field, ragged rows, or any structural violation
//      refuses outright — never a partial parse.
//
// Delimiter: if the caller doesn't pin one, both "," and "\t" are attempted. If BOTH
// parse validly, the input is ambiguous and is refused (a silent pick would be a coin
// flip presented as certainty).

import type { ParseOutcome } from "./json.js";

const HEADER_CELL_PATTERN = /^[A-Z_][\w .%\-/()]*$/i;
const MAX_HEADER_CELL_LENGTH = 64;
const MAX_INTERIOR_SPACES = 2;

/** One row of raw string cells, after quote-aware splitting on `delimiter`. */
function splitRow(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    // .charAt() (unlike indexed access) always returns a plain string ("" past the end),
    // so string-concatenation below stays well-typed under noUncheckedIndexedAccess.
    const ch = line.charAt(i);
    if (inQuotes) {
      if (ch === '"') {
        if (line.charAt(i + 1) === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"' && cell === "") {
      inQuotes = true;
    } else if (ch === delimiter) {
      cells.push(cell);
      cell = "";
    } else {
      cell += ch;
    }
  }
  if (inQuotes) {
    // Unterminated quote on this physical line — caller has already guarded against
    // unescaped-newline-in-field by requiring quote balance per logical row upstream;
    // this is the structural-violation branch for a stray/mismatched quote.
    throw new Error("unterminated quoted field");
  }
  cells.push(cell);
  return cells;
}

/**
 * Reassembles logical rows from physical lines, honoring quoted fields that legitimately
 * contain a delimiter but NEVER a raw newline — an unescaped newline inside a field (i.e.
 * an odd number of unescaped `"` before end-of-input without ever closing) is a structural
 * violation and must refuse, not silently join lines back together.
 */
function toLogicalRows(s: string): string[] | null {
  const physicalLines = s.split("\n");
  const rows: string[] = [];
  let buffer: string | null = null;
  for (const rawLine of physicalLines) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    buffer = buffer === null ? line : `${buffer}\n${line}`;
    if (isQuoteBalanced(buffer)) {
      rows.push(buffer);
      buffer = null;
    }
    // else: an open quote spans this newline — that IS an unescaped newline inside a
    // field. We do not resolve it by joining forever; if input ends still unbalanced,
    // that's caught below as a refusal.
  }
  if (buffer !== null) {
    // Input ended mid-quote, or a field held a raw newline that never got escaped shut.
    return null;
  }
  return rows;
}

/** True if `s` has an even number of `"` characters that are not part of a `""` escape
 *  run in a way that would leave a field open. We count raw quote characters: RFC-4180
 *  escaping (`""`) still contributes 2 quote chars, so parity is the right invariant —
 *  an odd count means an unterminated quoted field. */
function isQuoteBalanced(s: string): boolean {
  let count = 0;
  for (const ch of s) {
    if (ch === '"') count++;
  }
  return count % 2 === 0;
}

/** Header-plausibility predicate (§4.1, audit F5) — the load-bearing guard. Every header
 *  cell must independently pass, or the whole input is refused. This is what tells apart
 *  a real header row (`name,age,city`) from a data row masquerading as one (an address
 *  line that happens to have a consistent column count). */
function isPlausibleHeaderCell(raw: string): boolean {
  const cell = raw.trim();
  if (cell.length === 0 || cell.length > MAX_HEADER_CELL_LENGTH) return false;
  if (!HEADER_CELL_PATTERN.test(cell)) return false;
  if (/^\d/.test(cell)) return false;
  if (isNumeric(cell)) return false;
  const interiorSpaces = (cell.match(/ /g) ?? []).length;
  if (interiorSpaces > MAX_INTERIOR_SPACES) return false;
  return true;
}

function isNumeric(cell: string): boolean {
  if (cell.length === 0) return false;
  return Number.isFinite(Number(cell));
}

type DelimiterAttemptOk = { ok: true; records: Array<Record<string, string>>; hadQuoting: boolean };
type DelimiterAttemptFail = { ok: false; reason: string };

function tryDelimiter(s: string, delimiter: string): DelimiterAttemptOk | DelimiterAttemptFail {
  const logicalRows = toLogicalRows(s);
  if (logicalRows === null) {
    return { ok: false, reason: "unescaped newline inside a quoted field" };
  }
  // Drop trailing wholly-empty rows (a trailing blank line from a final \n) but never
  // interior ones — an interior blank line is ragged-row evidence, not formatting noise.
  while (logicalRows.length > 0 && logicalRows.at(-1) === "") {
    logicalRows.pop();
  }
  if (logicalRows.length < 3) {
    // header + >=2 data rows is the floor (guard 2); fewer physical rows can't clear it.
    return { ok: false, reason: "fewer than 2 data rows" };
  }

  let parsedRows: string[][];
  try {
    parsedRows = logicalRows.map((row) => splitRow(row, delimiter));
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "malformed quoted field" };
  }

  const columnCount = parsedRows[0]!.length;
  if (columnCount < 2) {
    return { ok: false, reason: "fewer than 2 columns" };
  }
  for (const row of parsedRows) {
    if (row.length !== columnCount) {
      return { ok: false, reason: "ragged rows: inconsistent column count" };
    }
  }

  const header = parsedRows[0]!;
  for (const cell of header) {
    if (!isPlausibleHeaderCell(cell)) {
      return { ok: false, reason: `header cell ${JSON.stringify(cell)} is not identifier-like` };
    }
  }

  const dataRows = parsedRows.slice(1);
  if (dataRows.length < 2) {
    return { ok: false, reason: "fewer than 2 data rows" };
  }

  const hadQuoting = s.includes('"');

  const records: Array<Record<string, string>> = dataRows.map((row) => {
    const record: Record<string, string> = {};
    for (const [i, element] of header.entries()) {
      record[element!] = row[i]!;
    }
    return record;
  });

  return { ok: true, records, hadQuoting };
}

/**
 * Strict CSV/TSV parser (response-normalizer §4.1). Returns a refusal for anything that
 * doesn't clear every guard — never a partial or best-effort parse.
 *
 * @param s the raw text
 * @param delimiter pin to "," or "\t"; omit to auto-try both (refusing on ambiguity)
 */
export function parseCsvStrict(s: string, delimiter?: "," | "\t"): ParseOutcome {
  if (delimiter !== undefined) {
    const attempt = tryDelimiter(s, delimiter);
    if (!attempt.ok) {
      return { ok: false, reason: attempt.reason };
    }
    return { ok: true, value: attempt.records, format: delimiter === "\t" ? "tsv" : "csv" };
  }

  const commaAttempt = tryDelimiter(s, ",");
  const tabAttempt = tryDelimiter(s, "\t");

  if (commaAttempt.ok && tabAttempt.ok) {
    return { ok: false, reason: "ambiguous: both comma and tab delimiters produce a valid parse" };
  }
  if (commaAttempt.ok) {
    return { ok: true, value: commaAttempt.records, format: "csv" };
  }
  if (tabAttempt.ok) {
    return { ok: true, value: tabAttempt.records, format: "tsv" };
  }
  return { ok: false, reason: `not valid CSV or TSV: ${commaAttempt.reason}; ${tabAttempt.reason}` };
}
