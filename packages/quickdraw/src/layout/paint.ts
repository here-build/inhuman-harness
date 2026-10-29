/**
 * paintFrame: Frame → cell buffer. Always lowers styles through a resolver.
 * Dual-dirty: reuse an existing Frame, pass a new theme.resolveStyle —
 * zero layout() calls.
 *
 * Theme defaults to ambient {@link paintTheme} (active theme + depth). Hosts
 * that attune at boot can omit the third arg; product present should still
 * pass an explicit binding. Empty `{}` is not legal — resolveStyle is required.
 */

import { wavefrontProminence } from "./birth.js";
import { resolveLiveText } from "./live_paint.js";
import { paintTheme } from "./paint_theme.js";
import type { Frame, Rect, Theme } from "./types.js";
import { fillBgFx, put, type Buffer, type Style } from "../buffer/index.js";
import { FgP } from "../lexicon/index.js";
import { displayWidth, splitAtWidth, takeGrapheme } from "../measure/index.js";
import { ansi256ToRgb } from "../theme/ansi256.js";

function applyThemeStyle(style: Style, theme: Theme): Style {
  return theme.resolveStyle(style);
}

function inScissor(s: Rect | undefined, x: number, y: number): boolean {
  if (!s) return true;
  return x >= s.x && x < s.x + s.w && y >= s.y && y < s.y + s.h;
}

/** Skip a grapheme cluster if any of its cells sit outside the scissor. */
function putInClip(buf: Buffer, x: number, y: number, text: string, style: Style, scissor: Rect | undefined): void {
  if (!scissor) {
    put(buf, x, y, text, style);
    return;
  }
  if (y < scissor.y || y >= scissor.y + scissor.h) return;
  const [head] = splitAtWidth(text, 10_000);
  let cx = x;
  let rest = head;
  while (rest.length > 0) {
    const [g, tail] = takeGrapheme(rest);
    if (!g) break;
    const gW = Math.max(1, displayWidth(g));
    let ok = true;
    for (let k = 0; k < gW; k++) {
      if (!inScissor(scissor, cx + k, y)) {
        ok = false;
        break;
      }
    }
    if (ok) put(buf, cx, y, g, style);
    cx += gW;
    rest = tail;
  }
}

/** Resolve transparent ink against the furniture already painted beneath it. */
function paintText(
  buf: Buffer,
  x: number,
  y: number,
  text: string,
  intent: Style,
  theme: Theme,
  scissor: Rect | undefined,
): void {
  const explicitSurface =
    intent.surfaceRole ||
    intent.surfaceRgb ||
    intent.fuseRole ||
    intent.bgRole ||
    intent.bgRgb ||
    intent.bg !== undefined ||
    intent.bgFx ||
    intent.cast === "transparent";
  if (explicitSurface || y < 0 || y >= buf.height) {
    putInClip(buf, x, y, text, applyThemeStyle(intent, theme), scissor);
    return;
  }
  let col = x;
  let remaining = text;
  const styles = new Map<string, Style>();
  while (remaining.length > 0) {
    const [head, tail] = takeGrapheme(remaining);
    if (!head) break;
    const under = col >= 0 && col < buf.width ? buf.cells[y * buf.width + col]?.style : undefined;
    const surfaceRgb = under?.bgRgb ?? (under?.bg === undefined ? undefined : ansi256ToRgb(under.bg));
    const key = surfaceRgb ? `${surfaceRgb.r},${surfaceRgb.g},${surfaceRgb.b}` : "ground";
    let style = styles.get(key);
    if (!style) {
      style = applyThemeStyle(surfaceRgb ? { ...intent, surfaceRgb } : intent, theme);
      styles.set(key, style);
    }
    putInClip(buf, col, y, head, style, scissor);
    col += Math.max(1, displayWidth(head));
    remaining = tail;
  }
}

function paintBirthLine(
  buf: Buffer,
  op: Extract<import("./types.js").PaintOp, { kind: "live" }>,
  theme: Theme,
  birth: ReadonlyMap<string, number> | undefined,
  scissor: Rect | undefined,
): void {
  const live = op.live;
  if (live.kind !== "birth") return;
  const src = op.content ?? "";
  if (!src) return;
  const rest = Math.max(0, live.T - live.tipWindow);
  const W = birth?.get(live.siteId) ?? rest;
  const fieldOpts = { birthFloor: live.birthFloor, falloff: live.falloff };
  let col = 0;
  let restText = src;
  while (restText.length > 0 && col < op.rect.w) {
    const [head, tail] = takeGrapheme(restText);
    if (!head) break;
    const gW = Math.max(1, displayWidth(head));
    const mid = live.offset + col + gW / 2;
    const p = wavefrontProminence(mid, W, live.T, live.target, fieldOpts);
    if (p <= 1 / 255) {
      col += gW;
      restText = tail;
      continue;
    }
    paintText(buf, op.rect.x + col, op.rect.y, head, { ...op.style, prominence: p }, theme, scissor);
    col += gW;
    restText = tail;
  }
}

export type PaintFrameOpts = {
  /**
   * Wall clock for live paint ops (spinner / elapsed / quota). Default Date.now().
   * Tests pass fixed nowMs for deterministic glyphs.
   */
  nowMs?: number;
  /**
   * Host-stepped birth wavefront W, keyed by `live.siteId`.
   * Missing → rest pose `max(0, T − tipWindow)`.
   */
  birth?: ReadonlyMap<string, number>;
};

export function paintFrame(frame: Frame, buf: Buffer, theme: Theme = paintTheme(), opts: PaintFrameOpts = {}): void {
  const nowMs = opts.nowMs ?? Date.now();
  for (const pos of frame.paintOrder) {
    const scissor = pos.clip;
    for (const op of pos.paint) {
      switch (op.kind) {
        case "live": {
          if (op.live.kind === "birth") {
            paintBirthLine(buf, op, theme, opts.birth, scissor);
            break;
          }
          const text = resolveLiveText(op.live, nowMs);
          // Spinner is 1 cell; elapsed is one line clipped to rect.w columns.
          const [line] = splitAtWidth(text, Math.max(1, op.rect.w));
          paintText(buf, op.rect.x, op.rect.y, line || " ", op.style, theme, scissor);
          break;
        }
        case "fill": {
          const style = applyThemeStyle(op.style, theme);
          // Procedural bg: write markers + baked UV only. Present materializes RGB.
          if (style.bgFx) {
            fillBgFx(buf, op.rect, style.bgFx, scissor);
            break;
          }
          const ch = " ";
          for (let dy = 0; dy < op.rect.h; dy++) {
            putInClip(buf, op.rect.x, op.rect.y + dy, ch.repeat(Math.max(0, op.rect.w)), style, scissor);
          }
          break;
        }
        case "border": {
          // Unstyled border ops (no fg/fgRgb/role stated) default to the
          // border role at ghost prominence — the system-wide default
          // border, never a bare index.
          const base: Style =
            op.style.fg === undefined && !op.style.fgRgb && !op.style.role
              ? { ...op.style, role: "border", prominence: op.style.prominence ?? FgP.ghost }
              : op.style;
          const style = applyThemeStyle(base, theme);
          const { x, y, w, h } = op.rect;
          if (w <= 0 || h <= 0) break;
          const hLine = "─".repeat(Math.max(0, w - 2));
          if (h >= 1) {
            const top = w >= 2 ? `┌${hLine}┐` : "│";
            putInClip(buf, x, y, top.slice(0, w), style, scissor);
          }
          if (h >= 2) {
            const bot = w >= 2 ? `└${hLine}┘` : "│";
            putInClip(buf, x, y + h - 1, bot.slice(0, w), style, scissor);
          }
          for (let dy = 1; dy < h - 1; dy++) {
            putInClip(buf, x, y + dy, "│", style, scissor);
            if (w >= 2) putInClip(buf, x + w - 1, y + dy, "│", style, scissor);
          }
          break;
        }
        case "text": {
          for (let i = 0; i < op.lines.length && i < op.rect.h; i++) {
            // Clip by display columns, not code units (CJK/emoji safe).
            const [head] = splitAtWidth(op.lines[i]!, op.rect.w);
            paintText(buf, op.rect.x, op.rect.y + i, head, op.style, theme, scissor);
          }
          break;
        }
        case "raw":
          op.paint(op.rect, buf);
          break;
      }
    }
  }
}
