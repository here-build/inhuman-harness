/**
 * Speculative composer echo — spec §3.
 *
 * State: boxId + predicted. Mutations via DraftOp
 * (key → keyEventToDraftOp → optional visual rewrite → applyDraftOp).
 * Soft-wrap vertical motion matches paint when `composerOuterWidth` is set.
 */

import { keyEventToDraftOp } from "./keys.js";
import { applyDraftOp, normalizeDraft, selectionRange, type DraftOp, type DraftState } from "../input/index.js";
import { chromeFrameTextWidth, moveVisualDraft, type VisualMotion } from "../layout/index.js";

export interface EchoState {
  readonly boxId: number | null;
  readonly predicted: DraftState | null;
  /**
   * Last reconcile disagreed with the prediction. Host snaps (clears
   * predicted); this flag is the detect, not a second draft loop.
   */
  readonly misaligned: boolean;
}

export function emptyEcho(): EchoState {
  return { boxId: null, predicted: null, misaligned: false };
}

export function withComposerBox(echo: EchoState, boxId: number | null): EchoState {
  if (echo.boxId === boxId) return echo;
  return { boxId, predicted: null, misaligned: false };
}

function baseState(echo: EchoState, current: DraftState): DraftState {
  return echo.predicted ?? current;
}

/**
 * When outer width is known, rewrite hard-line vertical/home/end to visual
 * setCaret so soft-wrap matches paint. DraftOp itself has no layout dep.
 * Host echo and the worker draft loop must share this or ↑ on a wrapped
 * paste inserts at different offsets than the caret on screen.
 */
export function maybeVisualMotion(op: DraftOp, state: DraftState, composerOuterWidth?: number): DraftOp {
  if (op.type !== "move") return op;
  const textW =
    typeof composerOuterWidth === "number" && composerOuterWidth > 0 ? chromeFrameTextWidth(composerOuterWidth) : 0;
  if (textW <= 0) return op;

  let visual: VisualMotion | null = null;
  switch (op.to) {
    case "line_up": {
      visual = "line_up";
      break;
    }
    case "line_down": {
      visual = "line_down";
      break;
    }
    case "home": {
      visual = "line_home";
      break;
    }
    case "end": {
      visual = "line_end";
      break;
    }
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

function isDestructiveOp(op: DraftOp): boolean {
  return op.type === "backspace" || op.type === "delete";
}

export function predict(
  echo: EchoState,
  current: DraftState,
  key: {
    readonly key: string;
    readonly ctrl?: boolean;
    readonly meta?: boolean;
    readonly alt?: boolean;
    readonly shift?: boolean;
  },
  opts?: { readonly composerOuterWidth?: number },
): EchoState {
  const mapped = keyEventToDraftOp(key);
  // Tab / Enter / Esc are worker commands, not draft mutations. A standing
  // prediction would hide the rewrite (slash-complete) or the clear (submit).
  if (mapped === null || mapped === "clear") {
    if (echo.predicted === null && !echo.misaligned) return echo;
    return { ...echo, predicted: null, misaligned: false };
  }

  const base = baseState(echo, current);
  const op = maybeVisualMotion(mapped, base, opts?.composerOuterWidth);
  const next = applyDraftOp(base, op);

  if (isDestructiveOp(op) && next.draft === base.draft && next.cursor === base.cursor && next.mark === base.mark) {
    return echo;
  }
  return { ...echo, predicted: next, misaligned: false };
}

/**
 * Authoritative box arrived. Clear the prediction. If `incoming` is given
 * and disagrees with what we showed, `misaligned` is true (snap, no replay).
 */
export function reconcile(echo: EchoState, boxId: number, incoming?: DraftState): EchoState {
  if (echo.predicted === null || echo.boxId !== boxId) {
    return echo.misaligned ? { ...echo, misaligned: false } : echo;
  }
  const misaligned =
    incoming !== undefined &&
    (echo.predicted.draft !== incoming.draft ||
      echo.predicted.cursor !== incoming.cursor ||
      (echo.predicted.mark ?? null) !== (incoming.mark ?? null));
  return { ...echo, predicted: null, misaligned };
}
