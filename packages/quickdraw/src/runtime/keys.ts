/**
 * Decoder events → Seam C key events (spec §3, protocol §4).
 *
 * Kill chords must NOT lower to letter keys (`u`/`k`): if `ctrl` were dropped
 * on the wire, isPrintable would inject those glyphs (obscure-symbols bug).
 * Tab is autocomplete (worker), never a draft insert — isPrintable would
 * otherwise type a tab. Shift+Enter is a worker-intent soft newline
 * (`insert "\n"`), not submit.
 * Wire keys → DraftOp is the app adapter; draft algebra lives in quickdraw-input.
 */
import type { DecodedKeyEvent } from "./box_bus.js";
import type { DraftOp, InputEvent } from "../input/index.js";

export const KEY_KILL_LINE_START = "KillLineStart";
export const KEY_KILL_LINE_END = "KillLineEnd";
export const KEY_UNDO = "Undo";
export const KEY_REDO = "Redo";
export const KEY_SELECT_ALL = "SelectAll";
/** Atomic paste: `Paste:` + JSON.stringify(text). */
export const KEY_PASTE_PREFIX = "Paste:";
export const KEY_COMPOSER_CARET = "ComposerCaret";

/**
 * Wire key → DraftOp. null = not a draft mutation; "clear" = drop prediction
 * (undo/redo). Soft-wrap spatial motion stays hard-line `move` here; echo may
 * rewrite to setCaret when composerOuterWidth is available.
 */
export type DraftKeyMapResult = DraftOp | "clear" | null;

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

function isPrintableKey(key: string, mods: { ctrl?: boolean; meta?: boolean; alt?: boolean }): boolean {
  if (mods.ctrl || mods.meta || mods.alt) return false;
  if ([...key].length !== 1) return false;
  return key >= " ";
}

/**
 * Wire key is a draft mutation. Single source: agree with keyEventToDraftOp —
 * DraftOp and not undo-clear. Do not hand-maintain a second subset.
 */
export function isDraftEditKey(event: {
  readonly key: string;
  readonly ctrl?: boolean;
  readonly meta?: boolean;
  readonly alt?: boolean;
  readonly shift?: boolean;
}): boolean {
  const op = keyEventToDraftOp(event);
  return op !== null && op !== "clear";
}

/**
 * Insert / backspace / delete / kill — the selected range is the entity to
 * replace. Motion and setCaret collapse or extend the mark themselves.
 */
export function isRangeEditKey(event: {
  readonly key: string;
  readonly ctrl?: boolean;
  readonly meta?: boolean;
  readonly alt?: boolean;
  readonly shift?: boolean;
}): boolean {
  if (!isDraftEditKey(event)) return false;
  const op = keyEventToDraftOp(event);
  return (
    op !== null &&
    op !== "clear" &&
    (op.type === "insert" || op.type === "backspace" || op.type === "delete" || op.type === "kill")
  );
}

function withKeyMods(
  key: string,
  mods: { readonly shift?: boolean; readonly alt?: boolean; readonly ctrl?: boolean; readonly meta?: boolean },
): DecodedKeyEvent {
  return {
    key,
    ...(mods.shift === true ? { shift: true as const } : {}),
    ...(mods.alt === true ? { alt: true as const } : {}),
    ...(mods.ctrl === true ? { ctrl: true as const } : {}),
    ...(mods.meta === true ? { meta: true as const } : {}),
  };
}

export function toKeyEvents(event: InputEvent): readonly DecodedKeyEvent[] {
  switch (event.type) {
    case "char":
      return [{ key: event.ch }];
    case "enter":
      return [withKeyMods("Enter", event)];
    case "shift_enter":
      return [withKeyMods("Enter", { shift: true })];
    case "tab":
      return [{ key: "Tab" }];
    case "shift_tab":
      return [{ key: "Tab", shift: true }];
    case "esc":
      return [withKeyMods("Escape", event)];
    case "backspace":
      return [{ key: "Backspace" }];
    case "delete":
      return [{ key: "Delete" }];
    case "up":
      return [{ key: "ArrowUp", shift: event.select }];
    case "down":
      return [{ key: "ArrowDown", shift: event.select }];
    case "left":
      return [{ key: "ArrowLeft", shift: event.select }];
    case "right":
      return [{ key: "ArrowRight", shift: event.select }];
    case "home":
      return [{ key: "Home", shift: event.select }];
    case "end":
      return [{ key: "End", shift: event.select }];
    case "word_left":
      return [{ key: "ArrowLeft", alt: true, shift: event.select }];
    case "word_right":
      return [{ key: "ArrowRight", alt: true, shift: event.select }];
    case "word_backspace":
      return [{ key: "Backspace", alt: true }];
    case "kill_to_start":
      return [{ key: KEY_KILL_LINE_START }];
    case "kill_to_end":
      return [{ key: KEY_KILL_LINE_END }];
    case "page_up":
      return [{ key: "PageUp" }];
    case "page_down":
      return [{ key: "PageDown" }];
    case "ctrl_c":
      return [{ key: "c", ctrl: true }];
    case "ctrl_x":
      return [{ key: "x", ctrl: true }];
    case "ctrl_o":
      return [{ key: "o", ctrl: true }];
    case "ctrl_v":
      // Host lowers this to `paste` with a clipboard body. Bare chord is not a glyph.
      return [];
    case "undo":
      return [{ key: KEY_UNDO }];
    case "redo":
      return [{ key: KEY_REDO }];
    case "select_all":
      return [{ key: KEY_SELECT_ALL }];
    case "paste":
      // One event for the whole body so undo treats paste as a single unit.
      return [pasteKeyEvent(event.text)];
    case "focus_in":
    case "focus_out":
    case "mouse":
    case "mod":
    case "osc_ground":
    case "theme_changed":
    case "unknown":
      return [];
  }
}

export function pasteKeyEvent(text: string): DecodedKeyEvent {
  return { key: `${KEY_PASTE_PREFIX}${JSON.stringify(text)}` };
}

export function parsePasteKeyEvent(event: DecodedKeyEvent): string | null {
  if (!event.key.startsWith(KEY_PASTE_PREFIX)) return null;
  try {
    const text: unknown = JSON.parse(event.key.slice(KEY_PASTE_PREFIX.length));
    return typeof text === "string" ? text : null;
  } catch {
    return null;
  }
}

export function toKeyEventBatch(events: readonly InputEvent[]): readonly DecodedKeyEvent[] {
  return events.flatMap(toKeyEvents);
}

/** Wire format: `ComposerCaret:${cursor}:${mark ?? "n"}` (DecodedKeyEvent has no numeric fields). */
export function composerCaretEvent(cursor: number, mark: number | null): DecodedKeyEvent {
  return {
    key: `${KEY_COMPOSER_CARET}:${cursor}:${mark === null ? "n" : mark}`,
  };
}

export function parseComposerCaretEvent(event: DecodedKeyEvent): { cursor: number; mark: number | null } | null {
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
