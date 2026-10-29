/**
 * Run-array draft beside the string algebra in draft.ts.
 *
 * A chip is one opaque run. Carets sit on run boundaries (a text run's
 * offset, or offset 0 of the following run). A chip is never indexed inside.
 * Copy projects the same slice two ways: clipboard keeps the chip, submit
 * flattens it to the string the model receives.
 */

export type RichChip = {
  readonly kind: "image" | "mention";
  readonly id: string;
  readonly clipboard: string;
  readonly submit: string;
};

export type RichRun = string | RichChip;

export type RichPoint = {
  readonly run: number;
  readonly offset: number;
};

export type RichState = {
  readonly runs: readonly RichRun[];
  readonly cursor: RichPoint;
  readonly mark: RichPoint | null;
};

export type RichCopy = {
  readonly clipboard: readonly RichRun[];
  readonly submit: readonly string[];
};

export type RichMotion = "left" | "right" | "word_left" | "word_right" | "home" | "end" | "line_up" | "line_down";

export type RichKill = "word" | "to_start" | "to_end";

function isChip(run: RichRun): run is RichChip {
  return typeof run !== "string";
}

function pointOrder(a: RichPoint, b: RichPoint): number {
  if (a.run !== b.run) return a.run - b.run;
  return a.offset - b.offset;
}

function mergeText(runs: readonly RichRun[]): RichRun[] {
  const merged: RichRun[] = [];
  for (const run of runs) {
    const prev = merged.at(-1);
    if (typeof run === "string" && typeof prev === "string") {
      merged[merged.length - 1] = prev + run;
    } else if (run !== "" || merged.length === 0) {
      merged.push(run);
    }
  }
  return merged.length === 0 ? [""] : merged;
}

/** Snap a point that landed inside a chip onto the chip's start boundary. */
function snap(runs: readonly RichRun[], point: RichPoint): RichPoint {
  if (point.run === runs.length) return { run: point.run, offset: 0 };
  const run = Math.max(0, Math.min(point.run, Math.max(0, runs.length - 1)));
  const piece = runs[run];
  if (piece === undefined || isChip(piece)) return { run, offset: 0 };
  return { run, offset: Math.max(0, Math.min(point.offset, piece.length)) };
}

function normalize(s: RichState): RichState {
  const runs = mergeText(s.runs.length === 0 ? [""] : s.runs);
  const cursor = snap(runs, s.cursor);
  const mark = s.mark === null ? null : snap(runs, s.mark);
  return {
    runs,
    cursor,
    mark: mark !== null && pointOrder(mark, cursor) === 0 ? null : mark,
  };
}

function rangeOf(s: RichState): { start: RichPoint; end: RichPoint } | null {
  if (s.mark === null || pointOrder(s.mark, s.cursor) === 0) return null;
  return pointOrder(s.mark, s.cursor) < 0 ? { start: s.mark, end: s.cursor } : { start: s.cursor, end: s.mark };
}

function sliceRuns(runs: readonly RichRun[], start: RichPoint, end: RichPoint): RichRun[] {
  const out: RichRun[] = [];
  for (let i = start.run; i <= end.run && i < runs.length; i++) {
    const piece = runs[i]!;
    if (isChip(piece)) {
      const startsAfter = i === start.run && start.offset > 0;
      const endsBefore = i === end.run && end.offset === 0;
      if (!startsAfter && !endsBefore) out.push(piece);
      continue;
    }
    const from = i === start.run ? start.offset : 0;
    const to = i === end.run ? end.offset : piece.length;
    if (from < to) out.push(piece.slice(from, to));
  }
  return out;
}

function replaceRange(s: RichState, start: RichPoint, end: RichPoint, inserted: readonly RichRun[]): RichState {
  const before = sliceRuns(s.runs, { run: 0, offset: 0 }, start);
  const afterStart = end.run < s.runs.length && isChip(s.runs[end.run]!) && end.offset === 0 ? end : end;
  const after = sliceRuns(s.runs, afterStart, { run: s.runs.length - 1, offset: tailOffset(s.runs) });
  const runs = mergeText([...before, ...inserted, ...after]);
  const cursor = caretAfter(runs, before, inserted);
  return normalize({ runs, cursor, mark: null });
}

function tailOffsetOf(runs: readonly RichRun[], run: number): number {
  const piece = runs[run];
  return typeof piece === "string" ? piece.length : 0;
}

function tailOffset(runs: readonly RichRun[]): number {
  const last = runs.at(-1);
  return typeof last === "string" ? last.length : 0;
}

function caretAfter(_runs: readonly RichRun[], before: readonly RichRun[], inserted: readonly RichRun[]): RichPoint {
  const consumed = mergeText([...before, ...inserted]);
  const last = consumed.at(-1);
  return { run: Math.max(0, consumed.length - 1), offset: typeof last === "string" ? last.length : 0 };
}

function step(s: RichState, dir: -1 | 1): RichPoint {
  const { runs, cursor } = s;
  const piece = runs[cursor.run];
  if (dir > 0) {
    if (typeof piece === "string" && cursor.offset < piece.length) {
      return { run: cursor.run, offset: cursor.offset + 1 };
    }
    const next = cursor.run + 1;
    if (next >= runs.length) return cursor;
    if (isChip(runs[next]!)) {
      const after = next + 1;
      if (after < runs.length) return { run: after, offset: 0 };
      // No text follows the chip. Park on a synthetic empty run so the caret
      // is past the chip, never on it.
      return { run: next + 1, offset: 0 };
    }
    return { run: next, offset: 0 };
  }
  if (typeof piece === "string" && cursor.offset > 0) {
    return { run: cursor.run, offset: cursor.offset - 1 };
  }
  let prev = cursor.run - 1;
  if (prev < 0) return cursor;
  if (isChip(runs[prev]!)) prev -= 1;
  if (prev < 0) return { run: 0, offset: 0 };
  const text = runs[prev];
  return typeof text === "string" ? { run: prev, offset: text.length } : { run: prev, offset: 0 };
}

function isWordChar(ch: string): boolean {
  return /[\p{L}\p{N}_]/u.test(ch);
}

function charAt(runs: readonly RichRun[], point: RichPoint, dir: -1 | 1): string | undefined {
  const piece = runs[point.run];
  if (typeof piece !== "string") return undefined;
  return dir > 0 ? piece[point.offset] : piece[point.offset - 1];
}

/** A word stops at a chip. Crossing one is its own motion, same as a grapheme step. */
function crossesChip(runs: readonly RichRun[], from: RichPoint, to: RichPoint): boolean {
  const lo = Math.min(from.run, to.run);
  const hi = Math.max(from.run, to.run);
  return runs.slice(lo, hi).some(isChip);
}

/**
 * Same word law as the string draft, with one extra stop: a chip is a gap.
 * A step that would cross a chip finishes the word on the near side instead.
 */
function wordStep(s: RichState, dir: -1 | 1): RichPoint {
  let point = s.cursor;
  let seenWord = false;
  const guard = s.runs.reduce((n, run) => n + (typeof run === "string" ? run.length : 1), 0) + 2;
  for (let i = 0; i < guard; i++) {
    const next = step({ ...s, cursor: point }, dir);
    if (next.run === point.run && next.offset === point.offset) return point;
    const chipAhead = dir > 0 && isChip(s.runs[point.run + 1]!);
    if (crossesChip(s.runs, point, next) || chipAhead) {
      if (seenWord) return point;
      if (dir > 0) return finishWordForward(s, point);
      return finishWordBackward(s, point, guard);
    }
    const ch = charAt(s.runs, next, dir);
    if (ch !== undefined && isWordChar(ch)) {
      seenWord = true;
      point = next;
      continue;
    }
    if (seenWord) return point;
    point = next;
  }
  return point;
}

function finishWordForward(s: RichState, point: RichPoint): RichPoint {
  const chipAt = s.runs.findIndex((run, index) => index > point.run && isChip(run));
  const near = chipAt === -1 ? point.run : chipAt - 1;
  const piece = s.runs[near];
  if (typeof piece !== "string") return point;
  let offset = near === point.run ? point.offset : 0;
  while (offset < piece.length && !isWordChar(piece[offset]!)) offset += 1;
  while (offset < piece.length && isWordChar(piece[offset]!)) offset += 1;
  if (offset < piece.length && piece[offset] === " ") offset += 1;
  return { run: near, offset };
}

function finishWordBackward(s: RichState, point: RichPoint, guard: number): RichPoint {
  const near = s.runs.findLastIndex((run, index) => index < point.run && typeof run === "string");
  let rest: RichPoint = near === -1 ? point : { run: near, offset: tailOffsetOf(s.runs, near) };
  for (let j = 0; j < guard; j++) {
    const piece = s.runs[rest.run];
    if (typeof piece !== "string" || rest.offset === 0) return rest;
    const ahead = piece[rest.offset - 1];
    if (ahead !== undefined && isWordChar(ahead)) {
      rest = { run: rest.run, offset: rest.offset - 1 };
      continue;
    }
    if (ahead === undefined) return rest;
    rest = { run: rest.run, offset: rest.offset - 1 };
  }
  return rest;
}

/** Display string for line bounds only: text unchanged, chip as its clipboard. */
function displayOf(runs: readonly RichRun[]): string {
  return runs.map((run) => (typeof run === "string" ? run : run.clipboard)).join("");
}

type LineSpan = { start: number; end: number; col: number };

/** Hard-line bounds of a display offset. Newlines live only inside text runs. */
function displayLine(display: string, at: number): LineSpan {
  const c = Math.max(0, Math.min(at, display.length));
  const start = display.lastIndexOf("\n", Math.max(0, c - 1)) + 1;
  const nl = display.indexOf("\n", c);
  const end = nl === -1 ? display.length : nl;
  return { start, end, col: c - start };
}

/** Map a display offset onto a legal caret. Inside a chip, snap to the nearer edge; a tie snaps before the chip. */
function pointAtDisplay(runs: readonly RichRun[], displayAt: number): RichPoint {
  let at = 0;
  for (let i = 0; i < runs.length; i++) {
    const piece = runs[i]!;
    const width = typeof piece === "string" ? piece.length : piece.clipboard.length;
    const next = at + width;
    if (displayAt < next || (displayAt === next && typeof piece === "string")) {
      if (typeof piece === "string") return { run: i, offset: displayAt - at };
      const before = displayAt - at;
      const after = next - displayAt;
      if (before < after) {
        const prev = runs[i - 1];
        return typeof prev === "string" ? { run: i - 1, offset: prev.length } : { run: i, offset: 0 };
      }
      return { run: i + 1, offset: 0 };
    }
    at = next;
  }
  const last = runs.at(-1);
  if (typeof last === "string") return { run: Math.max(0, runs.length - 1), offset: last.length };
  return { run: runs.length, offset: 0 };
}

function displayAtPoint(runs: readonly RichRun[], point: RichPoint): number {
  let at = 0;
  const run = Math.min(point.run, runs.length);
  for (let i = 0; i < run; i++) {
    const piece = runs[i]!;
    at += typeof piece === "string" ? piece.length : piece.clipboard.length;
  }
  if (point.run < runs.length && typeof runs[point.run] === "string") at += point.offset;
  return at;
}

function homePoint(runs: readonly RichRun[], cursor: RichPoint): RichPoint {
  const display = displayOf(runs);
  return pointAtDisplay(runs, displayLine(display, displayAtPoint(runs, cursor)).start);
}

function endPoint(runs: readonly RichRun[], cursor: RichPoint): RichPoint {
  const display = displayOf(runs);
  return pointAtDisplay(runs, displayLine(display, displayAtPoint(runs, cursor)).end);
}

function linePoint(runs: readonly RichRun[], cursor: RichPoint, dir: -1 | 1): RichPoint {
  const display = displayOf(runs);
  const here = displayAtPoint(runs, cursor);
  const line = displayLine(display, here);
  if (dir < 0) {
    if (line.start === 0) return cursor;
    const prevEnd = line.start - 1;
    const prev = displayLine(display, prevEnd);
    return pointAtDisplay(runs, Math.min(prev.start + line.col, prev.end));
  }
  if (line.end >= display.length) return cursor;
  const next = displayLine(display, line.end + 1);
  return pointAtDisplay(runs, Math.min(next.start + line.col, next.end));
}

/** Word start inside the current text run. A neighboring chip is not a word. */
function wordStartInRun(runs: readonly RichRun[], cursor: RichPoint): RichPoint {
  const piece = runs[cursor.run];
  if (typeof piece !== "string") return cursor;
  let i = cursor.offset;
  while (i > 0 && !isWordChar(piece[i - 1]!)) i -= 1;
  while (i > 0 && isWordChar(piece[i - 1]!)) i -= 1;
  return { run: cursor.run, offset: i };
}

function motionPoint(s: RichState, to: RichMotion): RichPoint {
  switch (to) {
    case "left":
      return step(s, -1);
    case "right":
      return step(s, 1);
    case "word_left":
      return wordStep(s, -1);
    case "word_right":
      return wordStep(s, 1);
    case "home":
      return homePoint(s.runs, s.cursor);
    case "end":
      return endPoint(s.runs, s.cursor);
    case "line_up":
      return linePoint(s.runs, s.cursor, -1);
    case "line_down":
      return linePoint(s.runs, s.cursor, 1);
  }
}

export function moveRich(s: RichState, to: RichMotion, select = false): RichState {
  const n = normalize(s);
  return normalize({ runs: n.runs, cursor: motionPoint(n, to), mark: select ? (n.mark ?? n.cursor) : null });
}

/** Mark at the start. Cursor after the last run. An empty draft stays collapsed. */
export function selectAllRich(s: RichState): RichState {
  const n = normalize(s);
  const only = n.runs.length === 1 && n.runs[0] === "";
  if (only) return n;
  const last = n.runs.at(-1);
  const cursor =
    typeof last === "string" ? { run: n.runs.length - 1, offset: last.length } : { run: n.runs.length, offset: 0 };
  return normalize({ runs: n.runs, cursor, mark: { run: 0, offset: 0 } });
}

export function insertRich(s: RichState, text: string): RichState {
  return pasteRich(s, [text]);
}

export function pasteRich(s: RichState, payload: string | readonly RichRun[]): RichState {
  const n = normalize(s);
  const inserted: readonly RichRun[] = typeof payload === "string" ? [payload] : payload;
  const range = rangeOf(n);
  if (range) return replaceRange(n, range.start, range.end, inserted);
  return replaceRange(n, n.cursor, n.cursor, inserted);
}

export function backspaceRich(s: RichState): RichState {
  const n = normalize(s);
  const range = rangeOf(n);
  if (range) return replaceRange(n, range.start, range.end, []);
  const from = step(n, -1);
  if (from.run === n.cursor.run && from.offset === n.cursor.offset) return n;
  return replaceRange(n, from, n.cursor, []);
}

export function deleteRich(s: RichState): RichState {
  const n = normalize(s);
  const range = rangeOf(n);
  if (range) return replaceRange(n, range.start, range.end, []);
  const to = step(n, 1);
  if (to.run === n.cursor.run && to.offset === n.cursor.offset) return n;
  return replaceRange(n, n.cursor, to, []);
}

/**
 * Kill. A selection goes as a whole. With no selection, word / hard-line
 * deletes stay inside the current text run and never take a neighboring chip.
 */
export function killRich(s: RichState, mode: RichKill): RichState {
  const n = normalize(s);
  const range = rangeOf(n);
  if (range) return replaceRange(n, range.start, range.end, []);
  const piece = n.runs[n.cursor.run];
  if (typeof piece !== "string") return n;
  if (mode === "word") {
    return replaceRange(n, wordStartInRun(n.runs, n.cursor), n.cursor, []);
  }
  const line = displayLine(displayOf(n.runs), displayAtPoint(n.runs, n.cursor));
  const from = Math.max(line.start, displayAtPoint(n.runs, { run: n.cursor.run, offset: 0 }));
  const to = Math.min(line.end, displayAtPoint(n.runs, { run: n.cursor.run, offset: piece.length }));
  const start = pointAtDisplay(n.runs, mode === "to_start" ? from : displayAtPoint(n.runs, n.cursor));
  const end = pointAtDisplay(n.runs, mode === "to_start" ? displayAtPoint(n.runs, n.cursor) : to);
  if (pointOrder(start, end) === 0) return n;
  return replaceRange(n, start, end, []);
}

export function copyRich(s: RichState, opts: { focused?: boolean } = {}): RichCopy {
  if (opts.focused === false) return { clipboard: [], submit: [] };
  const n = normalize(s);
  const range = rangeOf(n);
  if (!range) return { clipboard: [], submit: [] };
  const clipboard = sliceRuns(n.runs, range.start, range.end);
  const submit = clipboard.map((run) => (typeof run === "string" ? run : run.submit));
  return { clipboard, submit };
}
