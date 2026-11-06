/**
 * Self-contained pure input, hotkey, wire message, and composer picker primitives
 * for the TUI worker. Decouples the production TUI worker from the legacy
 * TypeScript Quickdraw runtime.
 */

// ── Chrome Hotkeys & Status Rail ─────────────────────────────────────────────

export type ChromeHotkey = {
  readonly key: string;
  readonly action: string;
  readonly event?: string;
};

export type ChromeQuotaWindow = {
  remainingPercent: number;
  resetAt?: number;
};

export type ChromeStatusChip = {
  text: string;
  role?: string;
  prominence?: number;
};

export type ChromeStatusItem = string | ChromeStatusChip;

export type ChordMods = {
  readonly key: string;
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly meta: boolean;
  readonly shift: boolean;
};

function normalizeKeyName(part: string): string {
  const p = part.toLowerCase();
  if (p === "esc" || p === "escape") return "Escape";
  if (p === "enter" || p === "return") return "Enter";
  if (p === "tab") return "Tab";
  if (p === "space") return " ";
  if ([...part].length === 1) return p;
  return part;
}

export function parseChord(chord: string): ChordMods | null {
  const raw = chord.trim();
  if (raw === "") return null;
  let body = raw;
  let ctrl = false;
  let alt = false;
  let meta = false;
  let shift = false;
  if (/^c-/i.test(body) && !/^(ctrl|control|cmd|command)([+-]|$)/i.test(body)) {
    ctrl = true;
    body = body.slice(2);
  }
  const parts = body.split(/[+-]/).filter((part) => part.length > 0);
  let key: string | undefined;
  for (const part of parts) {
    switch (part.toLowerCase()) {
      case "ctrl":
      case "control":
        ctrl = true;
        break;
      case "cmd":
      case "command":
      case "meta":
      case "super":
        meta = true;
        break;
      case "alt":
      case "option":
        alt = true;
        break;
      case "shift":
        shift = true;
        break;
      default:
        key = normalizeKeyName(part);
    }
  }
  if (key === undefined) return null;
  return { key, ctrl, alt, meta, shift };
}

export function eventMatchesChord(
  event: {
    readonly key: string;
    readonly ctrl?: boolean;
    readonly meta?: boolean;
    readonly alt?: boolean;
    readonly shift?: boolean;
  },
  chord: string,
): boolean {
  const parsed = parseChord(chord);
  if (parsed === null) return false;
  return (
    event.key.toLowerCase() === parsed.key.toLowerCase() &&
    (event.ctrl === true) === parsed.ctrl &&
    (event.meta === true) === parsed.meta &&
    (event.alt === true) === parsed.alt &&
    (event.shift === true) === parsed.shift
  );
}

// ── Host <-> Worker Up-Messages ──────────────────────────────────────────────

export interface DecodedKeyEvent {
  readonly key: string;
  readonly ctrl?: boolean;
  readonly alt?: boolean;
  readonly shift?: boolean;
  readonly meta?: boolean;
}

export interface InputEventsMessage {
  readonly kind: "input_events";
  readonly events: readonly DecodedKeyEvent[];
}

export interface ResizeMessage {
  readonly kind: "resize";
  readonly cols: number;
  readonly rows: number;
}

export interface PickerActivateMessage {
  readonly kind: "picker_activate";
  readonly key: string;
}

export interface PickerScrollMessage {
  readonly kind: "picker_scroll";
  readonly delta: 1 | -1;
}

export interface ActivateMessage {
  readonly kind: "activate";
  readonly key: string;
}

export interface AgentsScrollMessage {
  readonly kind: "agents_scroll";
  readonly delta: 1 | -1;
}

export interface AgentsFocusMessage {
  readonly kind: "agents_focus";
  readonly key: string;
}

export interface AgentsHoverMessage {
  readonly kind: "agents_hover";
  readonly key: string | null;
}

export interface SubmitPart {
  readonly text?: string;
  readonly image?: { readonly mime: string; readonly bytes: Uint8Array };
}

export interface SubmitCommand {
  readonly name: string;
  readonly args: Readonly<Record<string, string>>;
}

export interface SubmitMessage {
  readonly kind: "submit";
  readonly parts: readonly SubmitPart[];
  readonly command: SubmitCommand | null;
}

export type BoxBusUpMessage =
  | InputEventsMessage
  | ResizeMessage
  | PickerActivateMessage
  | PickerScrollMessage
  | AgentsScrollMessage
  | AgentsFocusMessage
  | AgentsHoverMessage
  | ActivateMessage
  | SubmitMessage;

export function receiveSubmit(message: { readonly kind: string }): {
  readonly parts: readonly SubmitPart[];
  readonly command: SubmitCommand | null;
} | null {
  if (message.kind !== "submit") return null;
  const submit = message as SubmitMessage;
  return { parts: submit.parts, command: submit.command };
}

// ── Agents Row Hit Keys & Root Inner Width ───────────────────────────────────

const SESSION_PREFIX = "session:";
const ROW = /^(session|call|bot):/;
const CHILD = /(?::name|:id-line|:id-row|:id|:title|:mark|:status|:recap|:indent|:dive:\d+)$/;

export function agentsRowKeyFromHit(key: string): string | null {
  if (key.includes(":gap:") || !ROW.test(key)) return null;
  let cur = key;
  while (CHILD.test(cur)) cur = cur.replace(CHILD, "");
  return ROW.test(cur) && cur !== "session:" && cur !== "call:" && cur !== "bot:" ? cur : null;
}

export function sessionIdFromAgentsKey(key: string): string | null {
  const row = agentsRowKeyFromHit(key);
  if (!row?.startsWith(SESSION_PREFIX)) return null;
  const id = row.slice(SESSION_PREFIX.length).trim();
  return id === "" ? null : id;
}

const ROOT_PAD_X = 1;
const CHROME_FRAME_BODY_CHROME = 4;

export function rootInnerWidth(cols: number): number {
  return Math.max(8, cols - ROOT_PAD_X * 2);
}

function chromeFrameTextWidth(outerW: number): number {
  return Math.max(1, outerW - CHROME_FRAME_BODY_CHROME);
}

// ── Pure Draft State & Editing Algebra ───────────────────────────────────────

export type DraftState = {
  readonly draft: string;
  readonly cursor: number;
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

export function selectionRange(s: DraftState): { a: number; b: number } | null {
  const n = normalizeDraft(s);
  if (n.mark === null || n.mark === n.cursor) return null;
  const a = Math.min(n.mark, n.cursor);
  const b = Math.max(n.mark, n.cursor);
  return a < b ? { a, b } : null;
}

const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function graphemeStarts(s: string): number[] {
  const starts: number[] = [];
  for (const { index } of GRAPHEME_SEGMENTER.segment(s)) starts.push(index);
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

export type DraftMotion =
  | "left"
  | "right"
  | "home"
  | "end"
  | "word_left"
  | "word_right"
  | "line_up"
  | "line_down";

export function hardLineBounds(draft: string, cursor: number): { start: number; end: number; col: number } {
  const c = clampCursor(draft, cursor);
  const start = draft.lastIndexOf("\n", Math.max(0, c - 1)) + 1;
  const nl = draft.indexOf("\n", c);
  const end = nl === -1 ? draft.length : nl;
  return { start, end, col: c - start };
}

export function lineUp(draft: string, cursor: number): number {
  const { start, col } = hardLineBounds(draft, cursor);
  if (start === 0) return clampCursor(draft, cursor);
  const prevEnd = start - 1;
  const prevStart = draft.lastIndexOf("\n", Math.max(0, prevEnd - 1)) + 1;
  return Math.min(prevStart + col, prevEnd);
}

export function lineDown(draft: string, cursor: number): number {
  const { end, col } = hardLineBounds(draft, cursor);
  if (end >= draft.length) return clampCursor(draft, cursor);
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
      return hardLineBounds(draft, cursor).start;
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

export function selectAllDraft(s: DraftState): DraftState {
  const n = normalizeDraft(s);
  if (n.draft.length === 0) return n;
  return { draft: n.draft, cursor: n.draft.length, mark: 0 };
}

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

export const KEY_KILL_LINE_START = "KillLineStart";
export const KEY_KILL_LINE_END = "KillLineEnd";
export const KEY_UNDO = "Undo";
export const KEY_REDO = "Redo";
export const KEY_SELECT_ALL = "SelectAll";
export const KEY_PASTE_PREFIX = "Paste:";
export const KEY_COMPOSER_CARET = "ComposerCaret";

export type DraftKeyMapResult = DraftOp | "clear" | null;

export function parsePasteKeyEvent(event: { readonly key: string }): string | null {
  if (!event.key.startsWith(KEY_PASTE_PREFIX)) return null;
  try {
    const text: unknown = JSON.parse(event.key.slice(KEY_PASTE_PREFIX.length));
    return typeof text === "string" ? text : null;
  } catch {
    return null;
  }
}

export function parseComposerCaretEvent(event: {
  readonly key: string;
}): { cursor: number; mark: number | null } | null {
  if (!event.key.startsWith(`${KEY_COMPOSER_CARET}:`)) return null;
  const parts = event.key.split(":");
  if (parts.length !== 3) return null;
  const cursor = Number(parts[1]);
  if (!Number.isFinite(cursor)) return null;
  const markRaw = parts[2]!;
  const mark = markRaw === "n" ? null : Number(markRaw);
  if (mark !== null && !Number.isFinite(mark)) return null;
  return { cursor, mark };
}

function isPrintableKey(key: string, mods: { ctrl?: boolean; meta?: boolean; alt?: boolean }): boolean {
  if (mods.ctrl || mods.meta || mods.alt) return false;
  if ([...key].length !== 1) return false;
  return key >= " ";
}

export function keyEventToDraftOp(key: {
  readonly key: string;
  readonly ctrl?: boolean;
  readonly meta?: boolean;
  readonly alt?: boolean;
  readonly shift?: boolean;
}): DraftKeyMapResult {
  if (key.meta === true) return null;

  if (key.key === KEY_UNDO || key.key === KEY_REDO) return "clear";
  if (key.key === KEY_SELECT_ALL) return { type: "selectAll" };

  const pasteText = parsePasteKeyEvent({ key: key.key });
  if (pasteText !== null) {
    if (pasteText.length === 0) return null;
    return { type: "insert", text: pasteText };
  }

  const caret = parseComposerCaretEvent({ key: key.key });
  if (caret !== null) {
    return { type: "setCaret", cursor: caret.cursor, mark: caret.mark };
  }

  if (key.key === "Backspace" && key.alt) {
    return { type: "kill", mode: "word" };
  }
  if (key.key === KEY_KILL_LINE_START || (key.ctrl && key.key === "u")) {
    return { type: "kill", mode: "to_start" };
  }
  if (key.key === KEY_KILL_LINE_END || (key.ctrl && key.key === "k")) {
    return { type: "kill", mode: "to_end" };
  }
  if (key.key === "Backspace" && !key.ctrl) {
    return { type: "backspace" };
  }
  if (key.key === "Delete" && !key.ctrl) {
    return { type: "delete" };
  }

  const select = key.shift === true;
  if (key.key === "ArrowLeft") {
    const to = key.alt || key.ctrl ? "word_left" : "left";
    return { type: "move", to, select };
  }
  if (key.key === "ArrowRight") {
    const to = key.alt || key.ctrl ? "word_right" : "right";
    return { type: "move", to, select };
  }
  if (key.key === "ArrowUp") {
    return { type: "move", to: "line_up", select };
  }
  if (key.key === "ArrowDown") {
    return { type: "move", to: "line_down", select };
  }
  if (key.key === "Home" && !key.ctrl) {
    return { type: "move", to: "home", select };
  }
  if (key.key === "End" && !key.ctrl) {
    return { type: "move", to: "end", select };
  }

  if (key.key === "Enter" && key.shift && !key.ctrl && !key.meta) {
    return { type: "insert", text: "\n" };
  }

  if (key.ctrl) return null;
  if (key.key === "Tab") return null;
  if (isPrintableKey(key.key, key)) {
    return { type: "insert", text: key.key };
  }
  return null;
}

// ── Visual Soft-Wrap Motion ──────────────────────────────────────────────────

function clusterWidth(cluster: string): number {
  if (cluster.length === 0) return 0;
  const cp = cluster.codePointAt(0) ?? 0;
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (
    cp === 0x23_ce ||
    cp === 0x24_aa ||
    cp === 0x24_b2 ||
    (cp >= 0x11_00 &&
      (cp <= 0x11_5f ||
        cp === 0x23_29 ||
        cp === 0x23_2a ||
        (cp >= 0x2e_80 && cp <= 0xa4_cf && cp !== 0x30_3f) ||
        (cp >= 0xac_00 && cp <= 0xd7_a3) ||
        (cp >= 0xf9_00 && cp <= 0xfa_ff) ||
        (cp >= 0xfe_10 && cp <= 0xfe_19) ||
        (cp >= 0xfe_30 && cp <= 0xfe_6f) ||
        (cp >= 0xff_00 && cp <= 0xff_60) ||
        (cp >= 0xff_e0 && cp <= 0xff_e6) ||
        (cp >= 0x1_f3_00 && cp <= 0x1_fa_ff) ||
        (cp >= 0x2_00_00 && cp <= 0x3_ff_fd)))
  ) {
    return 2;
  }
  return 1;
}

function textDisplayWidth(text: string): number {
  let w = 0;
  for (const { segment } of GRAPHEME_SEGMENTER.segment(text)) {
    w += clusterWidth(segment);
  }
  return w;
}

function splitAtDisplayWidth(text: string, maxCols: number): [string, string] {
  if (maxCols <= 0) return ["", text];
  let used = 0;
  let headEnd = 0;
  for (const { segment, index } of GRAPHEME_SEGMENTER.segment(text)) {
    const w = clusterWidth(segment);
    if (used + w > maxCols) {
      return [text.slice(0, headEnd), text.slice(headEnd)];
    }
    used += w;
    headEnd = index + segment.length;
  }
  return [text, ""];
}

function softWrapPreWrap(line: string, width: number): string[] {
  if (line === "") return [""];
  if (textDisplayWidth(line) <= width) return [line];
  const lines: string[] = [];
  let rest = line;
  while (rest.length > 0) {
    if (textDisplayWidth(rest) <= width) {
      lines.push(rest);
      break;
    }
    const [head, tail] = splitAtDisplayWidth(rest, width);
    if (head.length === 0) {
      const first = GRAPHEME_SEGMENTER.segment(rest)[Symbol.iterator]().next();
      const cluster = first.done ? "" : first.value.segment;
      if (!cluster) break;
      lines.push(cluster);
      rest = rest.slice(cluster.length);
      continue;
    }
    const sp = head.lastIndexOf(" ");
    if (sp !== -1 && sp < head.length - 1) {
      lines.push(head.slice(0, sp + 1));
      rest = head.slice(sp + 1) + tail;
    } else {
      lines.push(head);
      rest = tail;
    }
  }
  return lines.length > 0 ? lines : [""];
}

type VisualDraftLine = {
  readonly start: number;
  readonly end: number;
  readonly text: string;
};

function visualDraftLines(draft: string, textW: number): readonly VisualDraftLine[] {
  const w = Math.max(1, Math.floor(textW));
  if (draft.length === 0) return [{ start: 0, end: 0, text: "" }];
  const hardLines = draft.split("\n");
  const out: VisualDraftLine[] = [];
  let pos = 0;
  for (let hi = 0; hi < hardLines.length; hi++) {
    const hard = hardLines[hi]!;
    const soft = softWrapPreWrap(hard, w);
    let hardPos = 0;
    for (const line of soft) {
      const start = pos + hardPos;
      out.push({ start, end: start + line.length, text: line });
      hardPos += line.length;
    }
    if (soft.length === 0) {
      out.push({ start: pos, end: pos, text: "" });
    }
    pos += hard.length;
    if (hi < hardLines.length - 1) pos += 1;
  }
  return out.length > 0 ? out : [{ start: 0, end: 0, text: "" }];
}

function visualLineIndex(lines: readonly VisualDraftLine[], cursor: number, textW?: number): number {
  if (lines.length === 0) return 0;
  const c = Math.max(0, cursor);
  const w = textW === undefined ? undefined : Math.max(1, Math.floor(textW));
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (c >= line.start && c <= line.end) {
      if (c === line.end && i + 1 < lines.length && lines[i + 1]!.start === c) {
        continue;
      }
      if (w !== undefined && c === line.end && i === lines.length - 1 && textDisplayWidth(line.text) >= w) {
        return lines.length;
      }
      return i;
    }
  }
  return lines.length - 1;
}

function visualColInLine(draft: string, line: VisualDraftLine, cursor: number): number {
  const c = Math.max(line.start, Math.min(line.end, cursor));
  return textDisplayWidth(draft.slice(line.start, c));
}

function offsetAtVisualCol(draft: string, line: VisualDraftLine, targetCol: number): number {
  if (targetCol <= 0) return line.start;
  let col = 0;
  let offset = line.start;
  for (const { segment } of GRAPHEME_SEGMENTER.segment(draft.slice(line.start, line.end))) {
    const w = clusterWidth(segment);
    if (col + w > targetCol) return offset;
    col += w;
    offset += segment.length;
    if (col >= targetCol) return offset;
  }
  return line.end;
}

type VisualMotion = "line_up" | "line_down" | "line_home" | "line_end";

function moveVisualDraft(draft: string, cursor: number, textW: number, motion: VisualMotion): number {
  const w = Math.max(1, Math.floor(textW));
  const lines = visualDraftLines(draft, w);
  const c = Math.max(0, Math.min(draft.length, cursor));
  const idx = visualLineIndex(lines, c, w);
  if (idx >= lines.length) {
    switch (motion) {
      case "line_home":
      case "line_end":
      case "line_down":
        return c;
      case "line_up": {
        const prev = lines.at(-1)!;
        return offsetAtVisualCol(draft, prev, 0);
      }
    }
  }
  const line = lines[idx]!;
  switch (motion) {
    case "line_home":
      return line.start;
    case "line_end":
      return line.end;
    case "line_up": {
      if (idx <= 0) return c;
      const col = visualColInLine(draft, line, c);
      return offsetAtVisualCol(draft, lines[idx - 1]!, col);
    }
    case "line_down": {
      if (idx >= lines.length - 1) return c;
      const col = visualColInLine(draft, line, c);
      return offsetAtVisualCol(draft, lines[idx + 1]!, col);
    }
  }
}

export function maybeVisualMotion(op: DraftOp, state: DraftState, composerOuterWidth?: number): DraftOp {
  if (op.type !== "move") return op;
  const textW =
    typeof composerOuterWidth === "number" && composerOuterWidth > 0 ? chromeFrameTextWidth(composerOuterWidth) : 0;
  if (textW <= 0) return op;

  let visual: VisualMotion | null = null;
  switch (op.to) {
    case "line_up":
      visual = "line_up";
      break;
    case "line_down":
      visual = "line_down";
      break;
    case "home":
      visual = "line_home";
      break;
    case "end":
      visual = "line_end";
      break;
    case "left":
    case "right":
    case "word_left":
    case "word_right":
      break;
  }
  if (visual === null) return op;

  const n = normalizeDraft(state);
  const select = op.select === true;
  let from = n.cursor;
  if (!select) {
    const range = selectionRange(n);
    if (range) {
      from = visual === "line_up" || visual === "line_home" ? range.a : range.b;
    }
  }
  const nextCursor = moveVisualDraft(n.draft, from, textW, visual);
  if (!select) return { type: "setCaret", cursor: nextCursor, mark: null };
  return {
    type: "setCaret",
    cursor: nextCursor,
    mark: n.mark ?? n.cursor,
  };
}

// ── Composer Command & Picker Algebra ────────────────────────────────────────

export const COMPOSER_COMMAND_MAX_VISIBLE = 8;

export type ComposerCommand = {
  readonly name: string;
  readonly description?: string;
  readonly aliases?: readonly string[];
};

export type ComposerCommandAction = {
  readonly name: string;
  readonly displayName: string;
  readonly hotkey?: string;
};

export type ComposerCommandChoice = {
  readonly key?: string;
  readonly name: string;
  readonly status?: string;
  readonly annotation?: string;
  readonly description?: string;
  readonly actionDisplayName?: string;
  readonly actions: readonly ComposerCommandAction[];
  readonly href?: string;
};

export type ComposerCommandFallback = {
  readonly name: string;
  readonly displayName: string;
  readonly actions: readonly ComposerCommandAction[];
  readonly href?: string;
};

export type ComposerErrorAnnotation = {
  readonly level: "warning" | "error";
  readonly message: string;
};

export type ComposerCommandMatch = {
  readonly matches: readonly ComposerCommand[];
  readonly selected: ComposerCommand | null;
  readonly selectedIndex: number;
};

function verbToken(inputValue: string): string {
  const first = (inputValue.split("\n")[0] ?? "").trim();
  if (!first.startsWith("/")) return "";
  return (first.split(/\s/)[0] ?? "").slice(1).toLowerCase();
}

function commandNames(cmd: ComposerCommand): readonly string[] {
  const names = [cmd.name, ...(cmd.aliases ?? [])];
  return names.map((n) => n.replace(/^\//, "").toLowerCase());
}

export function matchComposerCommand(inputValue: string, commands: readonly ComposerCommand[]): ComposerCommandMatch {
  const token = verbToken(inputValue);
  if (token.length === 0 && !(inputValue.split("\n")[0] ?? "").trim().startsWith("/")) {
    return { matches: [], selected: null, selectedIndex: 0 };
  }
  const matches =
    token.length === 0 ? commands : commands.filter((c) => commandNames(c).some((n) => n.startsWith(token)));
  const selected = matches[0] ?? null;
  return {
    matches,
    selected,
    selectedIndex: 0,
  };
}

export function catalogKey(name: string): string {
  return `catalog:${name.replace(/^\//, "")}`;
}

export function reconcileSelectedKey(
  prev: string | null,
  rows: readonly { readonly key?: string; readonly name: string }[],
): string | null {
  const keys = rows.map((row, index) =>
    row.key != null && row.key !== "" ? row.key : `choice:${index}:${row.name}`,
  );
  if (prev != null && keys.includes(prev)) return prev;
  return keys[0] ?? null;
}

export function peekScroll(selectedIndex: number, n: number, viewport: number, scroll: number): number {
  if (n <= 0 || selectedIndex < 0) return 0;
  if (n <= viewport) return 0;
  const maxS = n - viewport;
  let lower = Math.max(0, selectedIndex - viewport + 1);
  let upper = Math.min(maxS, selectedIndex);
  if (viewport >= 3 && selectedIndex < n - 1) {
    lower = Math.max(lower, selectedIndex - viewport + 2);
  }
  if (viewport >= 3 && selectedIndex > 0) {
    upper = Math.min(upper, selectedIndex - 1);
  }
  if (lower > upper) {
    lower = Math.max(0, selectedIndex - viewport + 1);
    upper = Math.min(maxS, selectedIndex);
  }
  if (scroll >= lower && scroll <= upper) return scroll;
  if (scroll < lower) return lower;
  return upper;
}
