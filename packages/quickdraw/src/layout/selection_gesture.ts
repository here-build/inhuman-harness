/**
 * Selection gesture state machine — mouse events → SelectionState transitions.
 *
 * Pure state, no I/O. The host wires decoded mouse events in and reads
 * {@link GestureOutput} (a selection snapshot + optional edge-scroll signal)
 * out for paint + autoscroll.
 *
 * Visible-selection law (terminal/editor convergence):
 *   - A bare single click does **not** create a 1-cell selection. It only
 *     records the press so a subsequent drag can start from that cell, and
 *     clears any prior selection (click-to-dismiss).
 *   - Selection appears on: drag past the press cell, double-click (word),
 *     triple-click (line), Alt+drag (rect), or Shift+click extend.
 *
 * Containment (`userSelect: "contain"`, e.g. composer input):
 *   - When the press lands inside a contain region, the selection is armed
 *     with that rect. Every subsequent endpoint is clamped into it — drag
 *     cannot leave the input (browser <textarea> model).
 *
 * Click-count grammar:
 *   single   — arm a potential drag (no paint yet)
 *   double   — word granularity + expand to word bounds (when getRowCells given)
 *   triple   — line granularity + expand to full line (within contain if set)
 *   quad+    — cycles back to char (structural walk is Phase 4)
 *
 * Modifiers:
 *   Alt      — rectangular block granularity during a drag
 *   Shift    — extend the existing selection from its anchor (shift+click)
 */

import {
  clampCell,
  expandToLineAt,
  expandToWordAt,
  extendSelection,
  clearSelection,
  startSelection,
  type Cell,
  type SelectionGranularity,
  type SelectionState,
} from "./selection.js";
import type { Rect } from "./types.js";

/** Multi-click window in milliseconds (browser convention). */
const MULTI_CLICK_MS = 500;
/** Movement tolerance in cells — exceed this and it's a drag, not a click. */
const MOVE_TOLERANCE = 5;

export type ContainRegion = { key: string; rect: Rect };

export type GestureEvent = {
  kind: "press" | "release" | "drag";
  /** 0-indexed buffer cell (caller subtracts the SGR 1-base). */
  col: number;
  row: number;
  /** Event timestamp in ms (for multi-click windowing). */
  tMs: number;
  shift?: boolean;
  alt?: boolean;
  ctrl?: boolean;
  meta?: boolean;
  /** Optional LayoutNode key under the pointer (host hit-tests). */
  key?: string;
};

export type GestureOutput = {
  selection: SelectionState | null;
  /**
   * Edge-scroll signal during a drag. `undefined` when the drag is inside the
   * viewport. The host drives the actual scroll interval; this just flags
   * direction + that autoscroll is needed.
   */
  scroll?: "up" | "down";
  /**
   * True when this event completed a gesture that should copy-on-select
   * (release with a real extent). Hosts can also call `hasCopyableExtent`.
   */
  copyReady?: boolean;
};

export type GestureMachineOpts = {
  /** Viewport height in rows — for drag-to-edge-scroll detection. */
  viewportH?: number;
  /** Viewport width in cols — for triple-click line expand (non-contain). */
  viewportW?: number;
  /**
   * Optional row text accessor for double-click word snap. Return one row of
   * cell `ch` strings (index = column). When omitted, word granularity is set
   * but a collapsed word is discarded on release (same as bare click).
   */
  getRowCells?: (row: number) => readonly string[] | null | undefined;
  /**
   * Resolve `userSelect: "contain"` region at a cell (composer body, etc.).
   * When non-null, the gesture arms confinement for the whole drag.
   */
  containAt?: (cell: Cell) => ContainRegion | null;
};

type InternalState = {
  sel: SelectionState | null;
  /** Cell of the last press (drag origin + multi-click detection). */
  lastPressCell: Cell | null;
  /** Key under the last press (threaded into startSelection). */
  lastPressKey: string | undefined;
  /** Containment rect armed at press (input box). */
  contain: Rect | undefined;
  /** Timestamp of the last press. */
  lastPressMs: number;
  /** Consecutive click count at the same cell within the window. */
  clickCount: number;
  /** True between press and release. */
  dragging: boolean;
  /** Granularity armed at press (char until multi-click / Alt). */
  armedGranularity: SelectionGranularity;
  /** True once the selection has a real paint/copy extent. */
  movedOrExpanded: boolean;
};

/**
 * Should this selection paint / copy? Collapsed char (and collapsed word
 * without snap) is not a selection — it's a caret arm or a failed expand.
 */
function hasVisibleExtent(sel: SelectionState | null): boolean {
  if (!sel) return false;
  if (sel.granularity === "line" || sel.granularity === "structural") return true;
  return sel.anchor.col !== sel.active.col || sel.anchor.row !== sel.active.row;
}

export function createGestureMachine(opts: GestureMachineOpts = {}): {
  handle: (ev: GestureEvent) => GestureOutput;
  clear: () => SelectionState | null;
  selection: () => SelectionState | null;
  /** Update viewport dims without rebuilding (resize). */
  setViewport: (w: number, h: number) => void;
} {
  let viewportH = opts.viewportH;
  let viewportW = opts.viewportW;
  const getRowCells = opts.getRowCells;
  const containAt = opts.containAt;

  const st: InternalState = {
    sel: null,
    lastPressCell: null,
    lastPressKey: undefined,
    contain: undefined,
    lastPressMs: -Infinity,
    clickCount: 0,
    dragging: false,
    armedGranularity: "char",
    movedOrExpanded: false,
  };

  function clickCountToGranularity(count: number): SelectionGranularity {
    if (count >= 4) return "char";
    return (["char", "word", "line"] as const)[Math.min(count, 3) - 1]!;
  }

  function sameCell(a: Cell, b: Cell): boolean {
    return a.col === b.col && a.row === b.row;
  }

  function manhattan(a: Cell, b: Cell): number {
    return Math.abs(a.col - b.col) + Math.abs(a.row - b.row);
  }

  function edgeScroll(row: number): "up" | "down" | undefined {
    // Contained drags never autoscroll the outer viewport off the input.
    if (st.contain) return undefined;
    if (viewportH === undefined) return undefined;
    if (row < 0) return "up";
    if (row >= viewportH) return "down";
    return undefined;
  }

  function clamp(cell: Cell): Cell {
    return st.contain ? clampCell(cell, st.contain) : cell;
  }

  /**
   * Is the cell inside the armed contain rect (inclusive)? A pointer off the
   * box is not over the input's content, so its cell carries no position —
   * the endpoint stays at the last in-box cell instead.
   */
  function inContain(cell: Cell): boolean {
    const r = st.contain;
    if (!r) return true;
    const maxC = r.x + Math.max(1, r.w) - 1;
    const maxR = r.y + Math.max(1, r.h) - 1;
    return cell.col >= r.x && cell.col <= maxC && cell.row >= r.y && cell.row <= maxR;
  }

  function armContain(cell: Cell, evKey?: string): Cell {
    const region = containAt?.(cell) ?? null;
    st.contain = region?.rect;
    st.lastPressKey = region?.key ?? evKey;
    return clamp(cell);
  }

  /** Materialize a selection at press for multi-click / Alt; char stays armed only. */
  function materializeAtPress(cell: Cell, gran: SelectionGranularity): SelectionState | null {
    const key = st.lastPressKey;
    const contain = st.contain;
    if (gran === "word") {
      if (getRowCells) {
        st.movedOrExpanded = true;
        return expandToWordAt(cell, getRowCells, key, contain);
      }
      return null;
    }
    if (gran === "line") {
      st.movedOrExpanded = true;
      return expandToLineAt(cell, viewportW ?? 1, key, contain);
    }
    if (gran === "rect") {
      return null;
    }
    return null;
  }

  function handle(ev: GestureEvent): GestureOutput {
    if (ev.kind === "press") {
      // Shift+click extends the existing selection from its anchor.
      // Clamp into the existing contain (if any); do not re-arm from the new cell.
      if (ev.shift && st.sel && hasVisibleExtent(st.sel)) {
        st.contain = st.sel.contain;
        const cell = clamp({ col: ev.col, row: ev.row });
        st.sel = extendSelection(st.sel, cell);
        st.dragging = true;
        st.movedOrExpanded = true;
        st.lastPressCell = cell;
        st.lastPressMs = ev.tMs;
        return { selection: st.sel };
      }

      const raw: Cell = { col: ev.col, row: ev.row };
      // Multi-click detection uses the raw press cell (pre-clamp) so double-click
      // still matches the same physical click target.
      const withinWindow = ev.tMs - st.lastPressMs <= MULTI_CLICK_MS;
      const sameSpot = st.lastPressCell !== null && sameCell(st.lastPressCell, clamp(raw));
      // For multi-click, re-use prior contain if same spot; else arm fresh.
      const cell = withinWindow && sameSpot && st.contain ? clamp(raw) : armContain(raw, ev.key);

      st.clickCount = withinWindow && sameSpot ? st.clickCount + 1 : 1;
      st.lastPressCell = cell;
      st.lastPressMs = ev.tMs;

      const granularity = clickCountToGranularity(st.clickCount);
      const gran: SelectionGranularity = ev.alt ? "rect" : granularity;
      st.armedGranularity = gran;
      st.movedOrExpanded = false;
      st.dragging = true;

      // Clear any prior selection at gesture START (press), not release.
      // materializeAtPress returns null for bare char (armed only); word/line
      // replace the old range immediately. Hosts recolor from this return.
      st.sel = materializeAtPress(cell, gran);
      return { selection: hasVisibleExtent(st.sel) ? st.sel : null };
    }

    if (ev.kind === "drag") {
      const raw: Cell = { col: ev.col, row: ev.row };
      // Containment clamps the endpoint into the input, so a pointer *off* the
      // box still projects onto it — that projection can land on the anchor
      // and erase a range the drag already established (pointer drifting above
      // a single-row input in the anchor's column). An off-box cell carries no
      // real position then; keep the endpoint the drag last set.
      const clamped = clamp(raw);
      const offBox = !inContain(raw);
      const cell = offBox && st.sel !== null && sameCell(clamped, st.sel.anchor) ? st.sel.active : clamped;

      if (st.clickCount > 1 && st.lastPressCell && manhattan(st.lastPressCell, cell) > MOVE_TOLERANCE) {
        st.clickCount = 1;
        st.armedGranularity = "char";
        st.sel = startSelection(st.lastPressCell, "char", st.lastPressKey, st.contain);
        st.movedOrExpanded = !sameCell(st.lastPressCell, cell);
      }

      const gran: SelectionGranularity =
        st.armedGranularity === "rect" ? "rect" : (st.sel?.granularity ?? st.armedGranularity);

      if (!st.sel) {
        const origin = st.lastPressCell ?? cell;
        st.sel = startSelection(origin, gran, st.lastPressKey, st.contain);
      }

      if (!sameCell(st.sel.active, cell)) st.movedOrExpanded = true;
      st.sel = extendSelection({ ...st.sel, granularity: gran }, cell);

      if (!hasVisibleExtent(st.sel)) {
        return {
          selection: null,
          scroll: edgeScroll(ev.row),
        };
      }

      return { selection: st.sel, scroll: edgeScroll(ev.row) };
    }

    if (ev.kind === "release") {
      st.dragging = false;
      const raw: Cell = { col: ev.col, row: ev.row };
      const clamped = clamp(raw);
      // Same law as drag: a release off the box projects onto the input, and
      // that projection must not collapse the range at button-up — the drag
      // already established the extent the host commits as the draft mark.
      const cell = !inContain(raw) && st.sel !== null && sameCell(clamped, st.sel.anchor) ? st.sel.active : clamped;

      if (st.sel && hasVisibleExtent(st.sel) && st.clickCount <= 1 && !sameCell(st.sel.active, cell)) {
        st.sel = extendSelection(st.sel, cell);
        st.movedOrExpanded = true;
      }

      if (!hasVisibleExtent(st.sel)) {
        st.sel = null;
        st.movedOrExpanded = false;
        st.armedGranularity = "char";
        st.contain = undefined;
        return { selection: null, copyReady: false };
      }

      const copyReady = st.movedOrExpanded || hasVisibleExtent(st.sel);
      st.armedGranularity = "char";
      return { selection: st.sel, copyReady };
    }

    return { selection: hasVisibleExtent(st.sel) ? st.sel : null };
  }

  function clear(): SelectionState | null {
    st.sel = clearSelection();
    st.clickCount = 0;
    st.lastPressCell = null;
    st.lastPressKey = undefined;
    st.contain = undefined;
    st.dragging = false;
    st.movedOrExpanded = false;
    st.armedGranularity = "char";
    return st.sel;
  }

  function selection(): SelectionState | null {
    return hasVisibleExtent(st.sel) ? st.sel : null;
  }

  function setViewport(w: number, h: number): void {
    viewportW = w;
    viewportH = h;
  }

  return { handle, clear, selection, setViewport };
}
