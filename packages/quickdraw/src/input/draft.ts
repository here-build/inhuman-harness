/**
 * Pure draft editing — caret + optional mark (selection range).
 *
 * Browser textarea law:
 *   - motion without Shift collapses onto the previous range (not a step
 *     from the active end): left/word-left → start; right/word-right → end.
 *     Home/End/↑/↓ then move from that edge.
 *   - motion with Shift extends from a sticky mark
 *   - insert / paste overwrites the selected range
 *   - Backspace / Delete remove the selected range (not one side grapheme)
 */

export type DraftState = {
  readonly draft: string;
  /** UTF-16 caret offset into `draft`. */
  readonly cursor: number;
  /**
   * Selection anchor. `null` = caret only.
   * The selected range is [min(mark, cursor), max(mark, cursor)).
   */
  readonly mark: number | null;
};

export function clampCursor(draft: string, cursor: number): number {
  return Math.max(0, Math.min(draft.length, cursor));
}

export function normalizeDraft(s: DraftState): DraftState {
  const draft = s.draft;
  const cursor = clampCursor(draft, s.cursor);
  const mark = s.mark === null || s.mark === undefined ? null : clampCursor(draft, s.mark);
  return { draft, cursor, mark: mark === cursor ? null : mark };
}

/** Inclusive-exclusive range when a non-empty selection exists. */
export function selectionRange(s: DraftState): { a: number; b: number } | null {
  const n = normalizeDraft(s);
  if (n.mark === null || n.mark === n.cursor) return null;
  const a = Math.min(n.mark, n.cursor);
  const b = Math.max(n.mark, n.cursor);
  return a < b ? { a, b } : null;
}

function graphemeStarts(s: string): number[] {
  const starts: number[] = [];
  try {
    const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    for (const { index } of seg.segment(s)) starts.push(index);
  } catch {
    for (let i = 0; i < s.length;) {
      starts.push(i);
      const cp = s.codePointAt(i)!;
      i += cp > 0xff_ff ? 2 : 1;
    }
  }
  if (starts.length === 0) starts.push(0);
  return starts;
}

export function moveByGrapheme(draft: string, cursor: number, dir: -1 | 1): number {
  const starts = graphemeStarts(draft);
  const positions = [...starts, draft.length];
  const c = clampCursor(draft, cursor);
  if (dir < 0) {
    let prev = 0;
    for (const p of positions) {
      if (p >= c) return prev;
      prev = p;
    }
    return prev;
  }
  for (const p of positions) {
    if (p > c) return p;
  }
  return draft.length;
}

function isWordChar(ch: string): boolean {
  return /[\p{L}\p{N}_]/u.test(ch);
}

export function wordLeft(draft: string, cursor: number): number {
  let i = clampCursor(draft, cursor);
  while (i > 0 && !isWordChar(draft[i - 1]!)) i--;
  while (i > 0 && isWordChar(draft[i - 1]!)) i--;
  return i;
}

export function wordRight(draft: string, cursor: number): number {
  let i = clampCursor(draft, cursor);
  const n = draft.length;
  while (i < n && !isWordChar(draft[i]!)) i++;
  while (i < n && isWordChar(draft[i]!)) i++;
  return i;
}

export type DraftMotion = "left" | "right" | "home" | "end" | "word_left" | "word_right" | "line_up" | "line_down";

/**
 * Hard-line bounds around `cursor` (`\n`-separated).
 * `col` is the caret's offset within the line (0..line length).
 */
export function hardLineBounds(draft: string, cursor: number): { start: number; end: number; col: number } {
  const c = clampCursor(draft, cursor);
  const start = draft.lastIndexOf("\n", Math.max(0, c - 1)) + 1;
  const nl = draft.indexOf("\n", c);
  const end = nl === -1 ? draft.length : nl;
  return { start, end, col: c - start };
}

/** Move to the same column on the previous hard line (clamp to line length). */
export function lineUp(draft: string, cursor: number): number {
  const { start, col } = hardLineBounds(draft, cursor);
  if (start === 0) return clampCursor(draft, cursor);
  // Previous line ends at the `\n` before `start`.
  const prevEnd = start - 1;
  const prevStart = draft.lastIndexOf("\n", Math.max(0, prevEnd - 1)) + 1;
  return Math.min(prevStart + col, prevEnd);
}

/** Move to the same column on the next hard line (clamp to line length). */
export function lineDown(draft: string, cursor: number): number {
  const { end, col } = hardLineBounds(draft, cursor);
  if (end >= draft.length) return clampCursor(draft, cursor);
  // Next line starts after the `\n` at `end`.
  const nextStart = end + 1;
  const nl = draft.indexOf("\n", nextStart);
  const nextEnd = nl === -1 ? draft.length : nl;
  return Math.min(nextStart + col, nextEnd);
}

function applyMotion(draft: string, cursor: number, to: DraftMotion): number {
  switch (to) {
    case "left":
      return moveByGrapheme(draft, cursor, -1);
    case "right":
      return moveByGrapheme(draft, cursor, 1);
    case "home":
      return hardLineBounds(draft, cursor).start; // line home (Ctrl/Cmd+A still uses full via word path)
    case "end":
      return hardLineBounds(draft, cursor).end;
    case "word_left":
      return wordLeft(draft, cursor);
    case "word_right":
      return wordRight(draft, cursor);
    case "line_up":
      return lineUp(draft, cursor);
    case "line_down":
      return lineDown(draft, cursor);
  }
}

function motionTowardStart(to: DraftMotion): boolean {
  return to === "left" || to === "word_left" || to === "home" || to === "line_up";
}

function collapseOnly(to: DraftMotion): boolean {
  return to === "left" || to === "right" || to === "word_left" || to === "word_right";
}

/** Move caret; `select` extends from sticky mark (Shift). */
export function moveDraft(s: DraftState, to: DraftMotion, select = false): DraftState {
  const n = normalizeDraft(s);
  if (!select) {
    const range = selectionRange(n);
    if (range) {
      const edge = motionTowardStart(to) ? range.a : range.b;
      if (collapseOnly(to)) {
        return { draft: n.draft, cursor: edge, mark: null };
      }
      return { draft: n.draft, cursor: applyMotion(n.draft, edge, to), mark: null };
    }
    return { draft: n.draft, cursor: applyMotion(n.draft, n.cursor, to), mark: null };
  }
  const nextCursor = applyMotion(n.draft, n.cursor, to);
  const mark = n.mark ?? n.cursor;
  return normalizeDraft({ draft: n.draft, cursor: nextCursor, mark });
}

/** Select the whole draft. Empty stays collapsed. */
export function selectAllDraft(s: DraftState): DraftState {
  const n = normalizeDraft(s);
  if (n.draft.length === 0) return n;
  return { draft: n.draft, cursor: n.draft.length, mark: 0 };
}

/** Insert / paste — overwrites selection when present. */
export function insertDraft(s: DraftState, text: string): DraftState {
  const n = normalizeDraft(s);
  const range = selectionRange(n);
  if (range) {
    const draft = n.draft.slice(0, range.a) + text + n.draft.slice(range.b);
    return { draft, cursor: range.a + text.length, mark: null };
  }
  const draft = n.draft.slice(0, n.cursor) + text + n.draft.slice(n.cursor);
  return { draft, cursor: n.cursor + text.length, mark: null };
}

/** Backspace — deletes selection, else one grapheme before the caret. */
export function backspaceDraft(s: DraftState): DraftState {
  const n = normalizeDraft(s);
  const range = selectionRange(n);
  if (range) {
    return {
      draft: n.draft.slice(0, range.a) + n.draft.slice(range.b),
      cursor: range.a,
      mark: null,
    };
  }
  if (n.cursor <= 0) return n;
  const from = moveByGrapheme(n.draft, n.cursor, -1);
  return {
    draft: n.draft.slice(0, from) + n.draft.slice(n.cursor),
    cursor: from,
    mark: null,
  };
}

/** Delete — deletes selection, else one grapheme after the caret. */
export function deleteDraft(s: DraftState): DraftState {
  const n = normalizeDraft(s);
  const range = selectionRange(n);
  if (range) {
    return {
      draft: n.draft.slice(0, range.a) + n.draft.slice(range.b),
      cursor: range.a,
      mark: null,
    };
  }
  if (n.cursor >= n.draft.length) return n;
  const to = moveByGrapheme(n.draft, n.cursor, 1);
  return {
    draft: n.draft.slice(0, n.cursor) + n.draft.slice(to),
    cursor: n.cursor,
    mark: null,
  };
}

export function killDraft(s: DraftState, mode: "word" | "to_start" | "to_end"): DraftState {
  const n = normalizeDraft(s);
  // Non-empty selection: kill the selection (same as delete).
  const range = selectionRange(n);
  if (range) {
    return {
      draft: n.draft.slice(0, range.a) + n.draft.slice(range.b),
      cursor: range.a,
      mark: null,
    };
  }
  if (mode === "word") {
    const from = wordLeft(n.draft, n.cursor);
    return {
      draft: n.draft.slice(0, from) + n.draft.slice(n.cursor),
      cursor: from,
      mark: null,
    };
  }
  if (mode === "to_start") {
    return {
      draft: n.draft.slice(n.cursor),
      cursor: 0,
      mark: null,
    };
  }
  return {
    draft: n.draft.slice(0, n.cursor),
    cursor: n.cursor,
    mark: null,
  };
}

/**
 * Closed draft mutation algebra — wire keys stay in the host adapter.
 * Ops only: insert (incl. paste body / soft newline), backspace, delete,
 * kill modes, hard-line motion, absolute caret.
 */
export type DraftOp =
  | { readonly type: "insert"; readonly text: string }
  | { readonly type: "backspace" }
  | { readonly type: "delete" }
  | { readonly type: "kill"; readonly mode: "word" | "to_start" | "to_end" }
  | { readonly type: "move"; readonly to: DraftMotion; readonly select?: boolean }
  | { readonly type: "selectAll" }
  | {
      readonly type: "setCaret";
      readonly cursor: number;
      readonly mark: number | null;
    };

/** Apply one DraftOp via the existing pure algebra. */
export function applyDraftOp(state: DraftState, op: DraftOp): DraftState {
  switch (op.type) {
    case "insert":
      return insertDraft(state, op.text);
    case "backspace":
      return backspaceDraft(state);
    case "delete":
      return deleteDraft(state);
    case "kill":
      return killDraft(state, op.mode);
    case "move":
      return moveDraft(state, op.to, op.select === true);
    case "selectAll":
      return selectAllDraft(state);
    case "setCaret": {
      const n = normalizeDraft(state);
      const cursor = clampCursor(n.draft, op.cursor);
      const mark = op.mark === null ? null : clampCursor(n.draft, op.mark);
      return normalizeDraft({ draft: n.draft, cursor, mark });
    }
  }
}
