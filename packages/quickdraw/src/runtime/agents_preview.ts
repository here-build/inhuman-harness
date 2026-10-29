/**
 * Subagent sneak-peek: 90×90 centered overlay. Chrome-frame contour (not a
 * sharp box): process title on ╭╮, Esc: close on ╰╯, omnibox right-│ thumb.
 * Nested backdrop compounds with the agents drawer so the sidebar is 1× dim
 * and the attached tape is 2×. Viewer only — no attach, no composer.
 * Disclosures in the peeked tape still collapse on click.
 */
import { CHROME_FRAME_CHROME_ROWS, chromeFrameTextWidth } from "../layout/chrome_frame.js";
import { measureNode } from "../layout/measure.js";
import type { LayoutNode } from "../layout/types.js";
import { BgP, FgP } from "../lexicon/index.js";
import { thumbCoverage } from "../widgets/composer-picker.js";

/** Same key as {@link APP_FRAME_KEY} — kept local to avoid a paint_source cycle. */
const FRAME_KEY = "frame";
const FOLLOW_TAIL_SCROLL = Number.MAX_SAFE_INTEGER;
const PREVIEW_CLOSE: readonly { key: string; action: string }[] = [{ key: "Esc", action: "close" }];
/**
 * `│` + 1-cell pad. chromeFrameTextInset is composer `│ · ` (3) — that would
 * leave the tape flush against the right │.
 */
const PREVIEW_TAPE_INSET_X = 2;

export const APP_AGENTS_PREVIEW_OVERLAY_KEY = "agents:preview-overlay";
export const APP_AGENTS_PREVIEW_KEY = "agents:preview";
export const APP_AGENTS_PREVIEW_CHROME_KEY = "agents:preview:chrome";
export const APP_AGENTS_PREVIEW_BODY_KEY = "agents:preview:body";
export const APP_AGENTS_PREVIEW_VIEWPORT_KEY = "agents:preview:viewport";
export const APP_AGENTS_PREVIEW_TAPE_KEY = "agents:preview:tape";

/** Viewport fraction for the peek modal. */
export const AGENTS_PREVIEW_SCALE = 0.9;

const PANEL_FILL = { bgRole: "surface" as const, bgProminence: BgP.panel };

export function agentsPreviewRect(
  cols: number,
  rows: number,
): { readonly x: number; readonly y: number; readonly w: number; readonly h: number } {
  const w = Math.max(8, Math.floor(cols * AGENTS_PREVIEW_SCALE));
  const h = Math.max(4, Math.floor(rows * AGENTS_PREVIEW_SCALE));
  return {
    w,
    h,
    x: Math.floor((cols - w) / 2),
    y: Math.floor((rows - h) / 2),
  };
}

/** Width offered to the peeked tape: modal minus chrome_frame body chrome. */
export function agentsPreviewInnerWidth(cols: number): number {
  return Math.max(8, chromeFrameTextWidth(agentsPreviewRect(cols, 24).w));
}

export function withAgentsPreview(args: {
  readonly root: LayoutNode;
  readonly tape: LayoutNode;
  readonly cols: number;
  readonly rows: number;
  readonly title?: string;
  readonly scroll?: number;
  readonly atBottom?: boolean;
}): LayoutNode {
  const rect = agentsPreviewRect(args.cols, args.rows);
  const innerW = Math.max(1, chromeFrameTextWidth(rect.w));
  const innerH = Math.max(1, rect.h - CHROME_FRAME_CHROME_ROWS);
  const tapeH = Math.max(1, measureNode(args.tape, innerW, 10_000).h);
  const maxScroll = Math.max(0, tapeH - innerH);
  const atBottom = args.atBottom !== false;
  const scroll = atBottom ? maxScroll : Math.min(maxScroll, Math.max(0, args.scroll ?? 0));
  const title = (args.title ?? "").trim();
  const overlay: LayoutNode = {
    type: "overlay",
    key: APP_AGENTS_PREVIEW_OVERLAY_KEY,
    origin: { x: rect.x, y: rect.y },
    backdrop: true,
    children: [
      {
        type: "box",
        key: APP_AGENTS_PREVIEW_KEY,
        userSelect: "none",
        style: {
          width: rect.w,
          height: rect.h,
          overflow: "hidden",
          background: PANEL_FILL,
        },
        children: [
          {
            type: "chrome_frame",
            key: APP_AGENTS_PREVIEW_CHROME_KEY,
            width: rect.w,
            draft: "",
            topSegs:
              title === ""
                ? undefined
                : [
                    { text: "─ ", role: "foreground", prominence: FgP.ghost },
                    { text: title, role: "foreground", prominence: FgP.primary },
                    { text: " " },
                  ],
            hotkeys: PREVIEW_CLOSE,
            hotkeysBottom: true,
            bodyUserSelect: "none",
            bodySegRows: Array.from({ length: innerH }, () => [{ text: " " }]),
            bodyRightCoverage: thumbCoverage(tapeH, innerH, scroll),
          },
          {
            type: "overlay",
            key: APP_AGENTS_PREVIEW_BODY_KEY,
            origin: { x: PREVIEW_TAPE_INSET_X, y: 1 },
            children: [
              {
                type: "viewport",
                id: APP_AGENTS_PREVIEW_TAPE_KEY,
                key: APP_AGENTS_PREVIEW_VIEWPORT_KEY,
                overflowY: "scroll",
                overflowAnchor: "none",
                scroll: atBottom ? FOLLOW_TAIL_SCROLL : scroll,
                style: { width: innerW, height: innerH },
                children: [args.tape],
              },
            ],
          },
        ],
      },
    ],
  };
  if (args.root.type === "box" && args.root.key === FRAME_KEY) {
    return {
      ...args.root,
      children: [...(args.root.children ?? []), overlay],
    };
  }
  return {
    type: "box",
    key: FRAME_KEY,
    style: { width: args.cols, height: args.rows },
    children: [args.root, overlay],
  };
}
