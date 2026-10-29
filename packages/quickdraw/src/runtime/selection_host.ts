/**
 * Text selection on the UI thread — gesture + paint recolor + OSC 52.
 * Overlay only (like echo), never model authority. Recolor mutates the buffer
 * AFTER renderFrame returns (F11).
 */
import type { Buffer as CellBuffer } from "../buffer/index.js";
import { osc52Set } from "../capabilities/index.js";
import {
  containRegionAt,
  createGestureMachine,
  forEachHighlightCell,
  hasCopyableExtent,
  selectionRangeEnd,
  serializeSelection,
  type Cell,
  type Frame,
  type GestureEvent,
  type GestureOutput,
  type SelectionState,
} from "../layout/index.js";
import {
  ansi16ToRgb,
  ansi256ToRgb,
  selectionFillRgb,
  selectionRecolorBgRgb,
  selectionRecolorRgb,
} from "../theme/index.js";

export type SelectionHost = {
  handle(ev: GestureEvent): GestureOutput;
  clear(): SelectionState | null;
  selection(): SelectionState | null;
  setViewport(w: number, h: number): void;
  /** After every successful paint — word-snap / contain / copy read these. */
  bindPaint(buffer: CellBuffer, frame: Frame): void;
  recolor(buffer: CellBuffer, frame: Frame, ground: number): boolean;
  /** OSC 52 bytes when release is copy-ready; empty otherwise. */
  copyOscIfReady(out: GestureOutput): string;
  /** Last successful copy-on-select payload (plaintext). Empty until first copy. */
  lastCopy(): string;
  /** Last highlighted cell on the active end — plaque anchor, not the pointer. */
  rangeEnd(): Cell | null;
};

export function createSelectionHost(): SelectionHost {
  let lastBuffer: CellBuffer | null = null;
  let lastFrame: Frame | null = null;
  let sel: SelectionState | null = null;
  let lastCopied = "";
  /**
   * Content under the extent when the gesture last stamped it.
   * I7 reflow: if box_set slides different text under the same cells, serialize
   * diverges → refuse copy / drop selection. Not "clear on every box_set".
   */
  let contentStamp: string | null = null;

  const machine = createGestureMachine({
    getRowCells: (row) => {
      if (!lastBuffer) return null;
      const { width, height, cells } = lastBuffer;
      if (row < 0 || row >= height) return null;
      const out: string[] = new Array(width);
      const base = row * width;
      for (let c = 0; c < width; c++) out[c] = cells[base + c]?.ch ?? "";
      return out;
    },
    containAt: (cell) => {
      if (!lastFrame) return null;
      return containRegionAt(lastFrame, cell.col, cell.row);
    },
  });

  function serializeCurrent(selection: SelectionState): string {
    if (!lastBuffer || !lastFrame) return "";
    if (!hasCopyableExtent(selection)) return "";
    return serializeSelection(
      {
        cells: lastBuffer.cells,
        width: lastBuffer.width,
        height: lastBuffer.height,
      },
      lastFrame,
      selection,
    );
  }

  function stampFromSelection(selection: SelectionState | null): void {
    if (!selection) {
      contentStamp = null;
      return;
    }
    const text = serializeCurrent(selection);
    contentStamp = text.length > 0 ? text : null;
  }

  function invalidateIfContentMoved(): void {
    const current = sel ?? machine.selection();
    if (!current || contentStamp === null) return;
    const now = serializeCurrent(current);
    if (now !== contentStamp) {
      sel = machine.clear();
      contentStamp = null;
    }
  }

  return {
    handle(ev) {
      const out = machine.handle(ev);
      sel = out.selection;
      // Stamp while paint is still the pre-reflow frame.
      stampFromSelection(sel);
      return out;
    },
    clear() {
      sel = machine.clear();
      contentStamp = null;
      return sel;
    },
    selection() {
      return sel ?? machine.selection();
    },
    setViewport(w, h) {
      machine.setViewport(w, h);
    },
    bindPaint(buffer, frame) {
      lastBuffer = buffer;
      lastFrame = frame;
      invalidateIfContentMoved();
    },
    recolor(buffer, frame, ground) {
      const current = sel ?? machine.selection();
      if (!current) return false;
      let hit = 0;
      forEachHighlightCell(
        current,
        { cells: buffer.cells, width: buffer.width, height: buffer.height },
        frame,
        (col, row) => {
          const cell = buffer.cells[row * buffer.width + col];
          if (!cell) return;
          hit++;
          const next = { ...cell.style, selected: true as const };
          // Prefer truecolor; decode indexed fg so ansi16/256 still get AL shift.
          let fgRgb = next.fgRgb;
          if (!fgRgb && next.fg !== undefined) {
            fgRgb = next.fg <= 15 ? ansi16ToRgb(next.fg) : ansi256ToRgb(next.fg);
          }
          if (fgRgb) {
            next.fgRgb = selectionRecolorRgb(fgRgb, ground);
            next.fg = undefined;
          }
          let bgRgb = next.bgRgb;
          if (!bgRgb && next.bg !== undefined) {
            bgRgb = next.bg <= 15 ? ansi16ToRgb(next.bg) : ansi256ToRgb(next.bg);
          }
          next.bgRgb = bgRgb ? selectionRecolorBgRgb(bgRgb, ground) : selectionFillRgb(ground);
          next.bg = undefined;
          cell.style = next;
        },
      );
      if (hit === 0) {
        sel = machine.clear();
        contentStamp = null;
        return false;
      }
      return true;
    },
    copyOscIfReady(out) {
      if (!out.copyReady || !out.selection) return "";
      if (!hasCopyableExtent(out.selection)) return "";
      if (!lastBuffer || !lastFrame) return "";
      // Gesture out may carry a stale pre-reflow extent after bindPaint invalidation.
      if ((sel ?? machine.selection()) === null) return "";
      const text = serializeSelection(
        {
          cells: lastBuffer.cells,
          width: lastBuffer.width,
          height: lastBuffer.height,
        },
        lastFrame,
        out.selection,
      );
      // I7: paint under extent must still match stamp from when gesture established it.
      if (contentStamp !== null && text !== contentStamp) return "";
      if (text) lastCopied = text;
      return text ? osc52Set(text) : "";
    },
    lastCopy() {
      return lastCopied;
    },
    rangeEnd() {
      const current = sel ?? machine.selection();
      if (!current) return null;
      if (!lastBuffer || !lastFrame) return current.active;
      return selectionRangeEnd(current, lastBuffer, lastFrame);
    },
  };
}

/** SGR mouse button → gesture kind + modifiers. */
export function mouseToGesture(
  ev: {
    button: number;
    col: number;
    row: number;
    release: boolean;
  },
  tMs: number,
): { kind: "wheel"; delta: number } | { kind: "move" } | { kind: "gesture"; event: GestureEvent } | { kind: "ignore" } {
  // Bit 6 = wheel. Bit 0 distinguishes up (64) vs down (65).
  if ((ev.button & 64) !== 0) {
    if (ev.release) return { kind: "ignore" };
    if ((ev.button & 2) !== 0) return { kind: "ignore" }; // horizontal
    const down = (ev.button & 1) !== 0;
    return { kind: "wheel", delta: down ? 1 : -1 };
  }
  // 1003 any-motion is SGR button 35 (32+3). Must not fall through to drag —
  // motion over transcript would start a selection.
  if ((ev.button & 32) !== 0 && (ev.button & 3) === 3) {
    if (ev.release) return { kind: "ignore" };
    return { kind: "move" };
  }
  const kind: GestureEvent["kind"] = ev.release ? "release" : (ev.button & 32) === 0 ? "press" : "drag";
  // SGR is 1-based; gesture wants 0-based buffer cells.
  return {
    kind: "gesture",
    event: {
      kind,
      col: ev.col - 1,
      row: ev.row - 1,
      tMs,
      shift: (ev.button & 4) !== 0,
      alt: (ev.button & 8) !== 0,
      ctrl: (ev.button & 16) !== 0,
    },
  };
}
