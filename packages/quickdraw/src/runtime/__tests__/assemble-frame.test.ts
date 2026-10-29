import { expect, test } from "vitest";

import { layout, type LayoutNode } from "../../layout/index.js";
import { FgP } from "../../lexicon/index.js";
import {
  APP_AGENTS_PREVIEW_BODY_KEY,
  APP_AGENTS_PREVIEW_CHROME_KEY,
  APP_AGENTS_PREVIEW_KEY,
  APP_AGENTS_PREVIEW_OVERLAY_KEY,
  APP_AGENTS_PREVIEW_VIEWPORT_KEY,
} from "../agents_preview.js";
import {
  APP_AGENTS_METER_KEY,
  APP_AGENTS_OVERLAY_KEY,
  APP_AGENTS_VIEWPORT_KEY,
  APP_ASK_DIFF_KEY,
  APP_WAIT_PIN_KEY,
  APP_COMPOSER_KEY,
  APP_FRAME_KEY,
  APP_STATUSLINE_KEY,
  APP_TAPE_KEY,
  APP_TAPE_VIEWPORT_KEY,
  assemblePaintFrame,
  elideCwdParts,
  elidePathLeft,
  mailboxComposerSite,
  mailboxTapeSite,
  productColumn,
  ROOT_PAD_B,
  ROOT_PAD_T,
  ROOT_PAD_X,
  STATUSLINE_GAP,
  STATUSLINE_PAD_L,
  STATUSLINE_PAD_R,
  TAPE_PAD_B,
  TAPE_PAD_X,
  tapeFollowsTail,
  tapeViewportMetrics,
} from "../paint_source.js";
import { rasterLayout } from "../raster.js";

function kidsOf(node: LayoutNode): LayoutNode[] {
  return "children" in node ? (node.children ?? []) : [];
}

function walkKeys(node: unknown, keys: string[] = []): string[] {
  if (typeof node !== "object" || node === null) return keys;
  const rec = node as { key?: string; id?: string; children?: unknown[] };
  if (typeof rec.key === "string") keys.push(rec.key);
  if (Array.isArray(rec.children)) {
    for (const child of rec.children) walkKeys(child, keys);
  }
  return keys;
}

function cwdRestVoice(node: unknown): { role?: string; prominence?: number } | null {
  if (typeof node !== "object" || node === null) return null;
  const rec = node as {
    key?: string;
    style?: { role?: string; prominence?: number };
    children?: unknown[];
  };
  if (rec.key === "statusline:cwd:rest") return rec.style ?? {};
  if (Array.isArray(rec.children)) {
    for (const child of rec.children) {
      const hit = cwdRestVoice(child);
      if (hit != null) return hit;
    }
  }
  return null;
}

function statuslineNoteVoice(node: unknown): { role?: string; prominence?: number } | null {
  if (typeof node !== "object" || node === null) return null;
  const rec = node as {
    key?: string;
    style?: { role?: string; prominence?: number };
    children?: unknown[];
  };
  if (rec.key === "statusline:note") return rec.style ?? {};
  if (Array.isArray(rec.children)) {
    for (const child of rec.children) {
      const hit = statuslineNoteVoice(child);
      if (hit) return hit;
    }
  }
  return null;
}

function statuslineVoice(node: unknown): { role?: string; prominence?: number } | null {
  if (typeof node !== "object" || node === null) return null;
  const rec = node as {
    key?: string;
    style?: { role?: string; prominence?: number };
    children?: unknown[];
  };
  if (rec.key === "statusline:left:text" || rec.key === "statusline:cwd") return rec.style ?? {};
  if (Array.isArray(rec.children)) {
    for (const child of rec.children) {
      const hit = statuslineVoice(child);
      if (hit) return hit;
    }
  }
  return null;
}

function findViewport(node: unknown): { overflowAnchor?: string; scroll?: number } | null {
  if (typeof node !== "object" || node === null) return null;
  const rec = node as {
    type?: string;
    overflowAnchor?: string;
    scroll?: number;
    children?: unknown[];
  };
  if (rec.type === "viewport") return rec;
  if (Array.isArray(rec.children)) {
    for (const child of rec.children) {
      const hit = findViewport(child);
      if (hit) return hit;
    }
  }
  return null;
}

test("assemblePaintFrame is the product column; outer flex is not paintReady", () => {
  const root = assemblePaintFrame({
    tape: mailboxTapeSite(),
    composer: mailboxComposerSite(),
    cols: 80,
    rows: 24,
  });
  const column = productColumn(root);
  expect({
    frame: root.type,
    column: column.type,
    ready: root.paintReady,
  }).toEqual({ frame: "box", column: "flex", ready: undefined });
  expect(walkKeys(root)).toEqual([
    APP_FRAME_KEY,
    "root",
    APP_STATUSLINE_KEY,
    "statusline:left",
    "statusline:gap",
    "transcript:frame",
    "transcript:viewport",
    APP_TAPE_KEY,
    "rim",
    APP_COMPOSER_KEY,
  ]);
});

test("assemblePaintFrame seats identity ask on the pin; Diff ask in the viewport", () => {
  const identity = assemblePaintFrame({
    tape: mailboxTapeSite(),
    composer: mailboxComposerSite(),
    ask: { type: "box", key: "ask:body", children: [] },
    cols: 80,
    rows: 24,
  });
  const diff = assemblePaintFrame({
    tape: mailboxTapeSite(),
    composer: mailboxComposerSite(),
    ask: {
      type: "indentation_exception",
      kind: "diff",
      key: "ask:body",
      children: [],
    },
    cols: 80,
    rows: 24,
  });
  expect({
    identity: walkKeys(identity),
    diff: walkKeys(diff),
  }).toEqual({
    identity: [
      APP_FRAME_KEY,
      "root",
      APP_STATUSLINE_KEY,
      "statusline:left",
      "statusline:gap",
      "transcript:frame",
      APP_TAPE_VIEWPORT_KEY,
      APP_TAPE_KEY,
      "ask:pin",
      "ask:body",
      "rim",
      APP_COMPOSER_KEY,
    ],
    diff: [
      APP_FRAME_KEY,
      "root",
      APP_STATUSLINE_KEY,
      "statusline:left",
      "statusline:gap",
      "transcript:frame",
      APP_TAPE_VIEWPORT_KEY,
      APP_TAPE_KEY,
      APP_ASK_DIFF_KEY,
      "ask:body",
      "rim",
      APP_COMPOSER_KEY,
    ],
  });
});

test("assemblePaintFrame drops occupancy wait when ask already owns the pin", () => {
  const root = assemblePaintFrame({
    tape: mailboxTapeSite(),
    composer: mailboxComposerSite(),
    ask: { type: "box", key: "ask:body", children: [] },
    wait: { type: "box", key: "wait:body", children: [] },
    cols: 80,
    rows: 24,
  });
  const keys = walkKeys(root);
  expect(keys).toContain("ask:pin");
  expect(keys).not.toContain(APP_WAIT_PIN_KEY);
});

test("assemblePaintFrame seats occupancy wait immediately above the rim", () => {
  const root = assemblePaintFrame({
    tape: mailboxTapeSite(),
    composer: mailboxComposerSite(),
    wait: { type: "box", key: "wait:body", children: [] },
    cols: 80,
    rows: 24,
  });
  expect(walkKeys(root)).toEqual([
    APP_FRAME_KEY,
    "root",
    APP_STATUSLINE_KEY,
    "statusline:left",
    "statusline:gap",
    "transcript:frame",
    APP_TAPE_VIEWPORT_KEY,
    APP_TAPE_KEY,
    APP_WAIT_PIN_KEY,
    "wait:body",
    "rim",
    APP_COMPOSER_KEY,
  ]);
});

test("assemblePaintFrame follow-tail is present-side none + scroll, not auto", () => {
  const tape = {
    type: "box" as const,
    key: APP_TAPE_KEY,
    children: Array.from({ length: 20 }, (_, i) => ({
      type: "text" as const,
      content: `line-${i}`,
      key: `l${i}`,
    })),
  };
  const composer = mailboxComposerSite();
  const follow = layout(assemblePaintFrame({ tape, composer, cols: 40, rows: 12 }), { w: 40, h: 12 });
  const frozen = layout(
    assemblePaintFrame({
      tape,
      composer,
      cols: 40,
      rows: 12,
      atBottom: false,
      scroll: 0,
    }),
    { w: 40, h: 12 },
  );
  const followRoot = assemblePaintFrame({ tape, composer, cols: 40, rows: 12 });
  const followVp = tapeViewportMetrics(follow.byKey)!;
  const frozenVp = tapeViewportMetrics(frozen.byKey)!;
  const followLines = new Set(
    follow.paintOrder.flatMap((p) => p.paint.flatMap((op) => (op.kind === "text" ? op.lines : []))),
  );
  const frozenLines = new Set(
    frozen.paintOrder.flatMap((p) => p.paint.flatMap((op) => (op.kind === "text" ? op.lines : []))),
  );
  expect({
    follow: {
      anchor: findViewport(followRoot)?.overflowAnchor,
      scrollY: followVp.scrollY,
      maxScroll: followVp.maxScroll,
      last: followLines.has("line-19"),
      first: followLines.has("line-0"),
    },
    frozen: {
      scrollY: frozenVp.scrollY,
      last: frozenLines.has("line-19"),
      first: frozenLines.has("line-0"),
    },
    slack: [tapeFollowsTail(0, 0), tapeFollowsTail(9, 10), tapeFollowsTail(8, 10)],
  }).toEqual({
    follow: {
      anchor: "none",
      scrollY: followVp.maxScroll,
      maxScroll: followVp.maxScroll,
      last: true,
      first: false,
    },
    frozen: {
      scrollY: 0,
      last: false,
      first: true,
    },
    slack: [true, true, false],
  });
});

test("assemblePaintFrame squeezes the column and floors the tape above the rim", () => {
  const cols = 40;
  const rows = 12;
  const root = assemblePaintFrame({
    tape: { type: "text", key: APP_TAPE_KEY, content: "hello" },
    composer: { type: "text", key: APP_COMPOSER_KEY, content: "draft" },
    cols,
    rows,
  });
  const product = productColumn(root);
  const tapeFrame = kidsOf(product).find((child) => child.key === "transcript:frame");
  const frame = layout(root, { w: cols, h: rows });
  const viewport = frame.byKey.get(APP_TAPE_VIEWPORT_KEY);
  const composer = frame.byKey.get(APP_COMPOSER_KEY);
  expect({
    rootPad: product.type === "flex" ? product.style?.padding : undefined,
    tapePad: tapeFrame?.type === "box" ? tapeFrame.style?.padding : undefined,
    viewport: viewport && {
      x: viewport.hitRect.x,
      w: viewport.hitRect.w,
    },
    composer: composer && {
      x: composer.hitRect.x,
      w: composer.hitRect.w,
    },
    floor:
      viewport !== undefined && composer !== undefined
        ? composer.hitRect.y - (viewport.hitRect.y + viewport.hitRect.h)
        : undefined,
  }).toEqual({
    rootPad: { l: ROOT_PAD_X, t: ROOT_PAD_T, r: ROOT_PAD_X, b: ROOT_PAD_B },
    tapePad: { l: TAPE_PAD_X, r: TAPE_PAD_X, b: TAPE_PAD_B },
    viewport: {
      x: ROOT_PAD_X + TAPE_PAD_X,
      w: cols - ROOT_PAD_X * 2 - TAPE_PAD_X * 2,
    },
    composer: {
      x: ROOT_PAD_X,
      w: cols - ROOT_PAD_X * 2,
    },
    floor: TAPE_PAD_B,
  });
});

test("elidePathLeft keeps the tail", () => {
  expect({
    fit: elidePathLeft("/tmp/p", 6),
    cut: elidePathLeft("/Users/someuser/proj", 8),
    one: elidePathLeft("/tmp/p", 1),
    empty: elidePathLeft("/tmp/p", 0),
  }).toEqual({
    fit: "/tmp/p",
    cut: "…er/proj",
    one: "…",
    empty: "",
  });
});

test("elideCwdParts keeps the rest and cuts the root", () => {
  expect({
    fit: elideCwdParts("~/repo", "/pkg", 20),
    root: elideCwdParts("~/long/project/name", "/pkg", 12),
    rest: elideCwdParts("~/repo", "/packages/harness/src", 10),
  }).toEqual({
    fit: { root: "~/repo", rest: "/pkg" },
    root: { root: elidePathLeft("~/long/project/name", 8), rest: "/pkg" },
    rest: { root: "", rest: elidePathLeft("~/repo/packages/harness/src", 10) },
  });
});

test("assemblePaintFrame seats cwd on the draft column above the tape", () => {
  const cols = 40;
  const rows = 12;
  const root = assemblePaintFrame({
    tape: { type: "text", key: APP_TAPE_KEY, content: "hello" },
    composer: { type: "text", key: APP_COMPOSER_KEY, content: "draft" },
    statusline: { left: "main", note: "uncommitted", cwd: "/tmp/project" },
    cols,
    rows,
  });
  const frame = layout(root, { w: cols, h: rows });
  const viewport = frame.byKey.get(APP_TAPE_VIEWPORT_KEY);
  const cwd = frame.byKey.get("statusline:cwd");
  const left = frame.byKey.get("statusline:left:text");
  expect({
    left: left && { x: left.hitRect.x, y: left.hitRect.y },
    cwd: cwd && {
      x: cwd.hitRect.x,
      y: cwd.hitRect.y,
      w: cwd.hitRect.w,
    },
    above:
      viewport !== undefined && left !== undefined ? viewport.hitRect.y - (left.hitRect.y + left.hitRect.h) : undefined,
    voice: statuslineVoice(root),
    note: statuslineNoteVoice(root),
    floor: ROOT_PAD_B,
  }).toEqual({
    left: { x: ROOT_PAD_X + STATUSLINE_PAD_L, y: ROOT_PAD_T },
    cwd: {
      x: cols - ROOT_PAD_X - STATUSLINE_PAD_R - "/tmp/project".length,
      y: ROOT_PAD_T,
      w: "/tmp/project".length,
    },
    above: STATUSLINE_GAP,
    voice: { role: "foreground", prominence: FgP.secondary },
    note: { role: "foreground", prominence: FgP.rising },
    floor: 0,
  });
});

test("assemblePaintFrame dims the path inside the git root", () => {
  const tree = assemblePaintFrame({
    tape: { type: "text", key: APP_TAPE_KEY, content: "hello" },
    composer: { type: "text", key: APP_COMPOSER_KEY, content: "draft" },
    statusline: { cwd: "~/repo/pkg", cwdRoot: "~/repo" },
    cols: 40,
    rows: 12,
  });
  const frame = layout(tree, { w: 40, h: 12 });
  const repo = frame.byKey.get("statusline:cwd");
  const rest = frame.byKey.get("statusline:cwd:rest");
  expect({
    keys: walkKeys(tree).filter((key) => key.startsWith("statusline:")),
    repo: repo?.hitRect.w,
    rest: rest && repo ? { w: rest.hitRect.w, dx: rest.hitRect.x - (repo.hitRect.x + repo.hitRect.w) } : undefined,
    restVoice: cwdRestVoice(tree),
  }).toEqual({
    keys: ["statusline:left", "statusline:path", "statusline:cwd", "statusline:cwd:rest", "statusline:gap"],
    repo: "~/repo".length,
    rest: { w: "/pkg".length, dx: 0 },
    restVoice: { role: "foreground", prominence: FgP.ghost },
  });
});

test("agents overlay is a stacking sibling; tape wrap width does not change", () => {
  const cols = 40;
  const rows = 12;
  const tape = {
    type: "text" as const,
    key: APP_TAPE_KEY,
    content: "identity-line-that-must-wrap-the-same-whether-the-drawer-is-closed-or-open",
    whiteSpace: "normal" as const,
  };
  const composer = mailboxComposerSite();
  const panel = { type: "text" as const, key: "agents:body", content: "Explore" };
  const closed = assemblePaintFrame({ tape, composer, cols, rows });
  const open = assemblePaintFrame({ tape, composer, cols, rows, agents: panel });
  const closedFrame = layout(closed, { w: cols, h: rows });
  const openFrame = layout(open, { w: cols, h: rows });
  const closedVp = tapeViewportMetrics(closedFrame.byKey)!;
  const openVp = tapeViewportMetrics(openFrame.byKey)!;
  const column = productColumn(open);
  expect({
    wrap: [closedVp.hitRect.w, openVp.hitRect.w],
    overlayInColumn: kidsOf(column).some((child) => child.type === "overlay"),
    overlayKeys: walkKeys(open).filter((key) => key.startsWith("agents")),
    meter: walkKeys(
      assemblePaintFrame({
        tape,
        composer,
        cols,
        rows,
        agentsMeter: { type: "text", key: "agents:meter:line", content: "←: overview" },
      }),
    ),
  }).toEqual({
    wrap: [closedVp.hitRect.w, closedVp.hitRect.w],
    overlayInColumn: false,
    overlayKeys: [APP_AGENTS_OVERLAY_KEY, "agents:panel", APP_AGENTS_VIEWPORT_KEY, "agents:body"],
    meter: [
      APP_FRAME_KEY,
      "root",
      APP_STATUSLINE_KEY,
      "statusline:left",
      APP_AGENTS_METER_KEY,
      "agents:meter:line",
      "statusline:gap",
      "transcript:frame",
      APP_TAPE_VIEWPORT_KEY,
      APP_TAPE_KEY,
      "rim",
      APP_COMPOSER_KEY,
    ],
  });
});

test("subagent preview is a 90×90 chrome-frame overlay on top of the drawer", () => {
  const cols = 40;
  const rows = 20;
  const tree = assemblePaintFrame({
    tape: {
      type: "box",
      key: APP_TAPE_KEY,
      children: [{ type: "text", key: "tape-line", content: "hello", style: { role: "foreground" } }],
    },
    composer: mailboxComposerSite(),
    cols,
    rows,
    agents: { type: "text", key: "agents:body", content: "Explore" },
    agentsPreview: { type: "text", key: "preview:tape", content: "map the repo" },
    agentsPreviewTitle: "Explore",
  });
  const frame = layout(tree, { w: cols, h: rows });
  const modal = frame.byKey.get(APP_AGENTS_PREVIEW_KEY);
  const region = (key: string) =>
    frame.paintOrder
      .filter((pos) => pos.key === key)
      .flatMap((pos) => pos.paint.flatMap((op) => (op.kind === "raw" ? [] : [op.style.regionProminence])));
  const chars = rasterLayout(tree, cols, rows);
  const rect = modal?.hitRect;
  const tape = frame.byKey.get(APP_AGENTS_PREVIEW_VIEWPORT_KEY)?.hitRect;
  const top = rect === undefined ? "" : (chars[rect.y] ?? "").slice(rect.x, rect.x + rect.w);
  const bot = rect === undefined ? "" : (chars[rect.y + rect.h - 1] ?? "").slice(rect.x, rect.x + rect.w);
  expect({
    keys: walkKeys(tree).filter((key) => key.startsWith("agents:preview")),
    rect,
    pad:
      rect === undefined || tape === undefined ? null : { l: tape.x - rect.x, r: rect.x + rect.w - (tape.x + tape.w) },
    last: kidsOf(tree).at(-1)?.key,
    dim: {
      tape: region("tape-line"),
      side: region("agents:panel"),
      modal: region(APP_AGENTS_PREVIEW_KEY),
    },
    corners:
      rect === undefined
        ? null
        : {
            tl: chars[rect.y]?.[rect.x],
            tr: chars[rect.y]?.[rect.x + rect.w - 1],
            bl: chars[rect.y + rect.h - 1]?.[rect.x],
            br: chars[rect.y + rect.h - 1]?.[rect.x + rect.w - 1],
          },
    chrome: {
      title: top.includes("Explore"),
      esc: bot.includes("Esc"),
      close: bot.includes("close"),
    },
  }).toEqual({
    keys: [
      APP_AGENTS_PREVIEW_OVERLAY_KEY,
      APP_AGENTS_PREVIEW_KEY,
      APP_AGENTS_PREVIEW_CHROME_KEY,
      APP_AGENTS_PREVIEW_BODY_KEY,
      APP_AGENTS_PREVIEW_VIEWPORT_KEY,
    ],
    rect: { x: 2, y: 1, w: 36, h: 18 },
    pad: { l: 2, r: 2 },
    last: APP_AGENTS_PREVIEW_OVERLAY_KEY,
    dim: {
      tape: [0.4 * 0.4],
      side: [0.4],
      modal: [undefined],
    },
    corners: { tl: "╭", tr: "╮", bl: "╰", br: "╯" },
    chrome: { title: true, esc: true, close: true },
  });
});

test("sneak-peek right-│ thumb sits on the tail when the tape overflows", () => {
  const tree = assemblePaintFrame({
    tape: mailboxTapeSite(),
    composer: mailboxComposerSite(),
    cols: 40,
    rows: 16,
    agents: { type: "text", key: "agents:body", content: "Explore" },
    agentsPreview: {
      type: "box",
      key: "preview:tape",
      children: Array.from({ length: 40 }, (_, i) => ({
        type: "text" as const,
        key: `peek-${i}`,
        content: `peek-${i}`,
        whiteSpace: "nowrap" as const,
      })),
    },
    agentsPreviewAtBottom: true,
  });
  const chrome = findChromeFrame(tree);
  const coverage = chrome?.bodyRightCoverage ?? [];
  expect({
    n: coverage.length > 1,
    tail: (coverage.at(-1) ?? 0) > (coverage[0] ?? 0),
    some: coverage.some((cell) => cell > 0),
  }).toEqual({ n: true, tail: true, some: true });
});

test("assemblePaintFrame atTip is today's column; off-tip neighbors hide the rim", () => {
  const atTip = assemblePaintFrame({
    tape: mailboxTapeSite(),
    composer: mailboxComposerSite(),
    cols: 80,
    rows: 24,
    atTip: true,
    futureNeighbors: { type: "text", key: "rewind:ahead", content: "› two" },
  });
  const offTip = assemblePaintFrame({
    tape: mailboxTapeSite(),
    composer: mailboxComposerSite(),
    cols: 80,
    rows: 24,
    atTip: false,
    pastNeighbors: { type: "text", key: "rewind:behind", content: "› one" },
    futureNeighbors: { type: "text", key: "rewind:ahead", content: "› two" },
  });
  const steal = assemblePaintFrame({
    tape: mailboxTapeSite(),
    composer: mailboxComposerSite(),
    cols: 80,
    rows: 24,
    atTip: false,
    seatRim: true,
    pastNeighbors: { type: "text", key: "rewind:behind", content: "› one" },
    futureNeighbors: { type: "text", key: "rewind:ahead", content: "› two" },
  });
  expect({
    atTip: walkKeys(atTip),
    offTip: walkKeys(offTip),
    steal: walkKeys(steal),
  }).toEqual({
    atTip: [
      APP_FRAME_KEY,
      "root",
      APP_STATUSLINE_KEY,
      "statusline:left",
      "statusline:gap",
      "transcript:frame",
      APP_TAPE_VIEWPORT_KEY,
      APP_TAPE_KEY,
      "rim",
      APP_COMPOSER_KEY,
    ],
    offTip: [
      APP_FRAME_KEY,
      "root",
      APP_STATUSLINE_KEY,
      "statusline:left",
      "statusline:gap",
      "rewind:behind",
      "transcript:frame",
      APP_TAPE_VIEWPORT_KEY,
      APP_TAPE_KEY,
      "rewind:ahead",
    ],
    steal: [
      APP_FRAME_KEY,
      "root",
      APP_STATUSLINE_KEY,
      "statusline:left",
      "statusline:gap",
      "rewind:behind",
      "transcript:frame",
      APP_TAPE_VIEWPORT_KEY,
      APP_TAPE_KEY,
      "rim",
      APP_COMPOSER_KEY,
      "rewind:ahead",
    ],
  });
});

function findChromeFrame(node: unknown): { bodyRightCoverage?: number[] } | null {
  if (typeof node !== "object" || node === null) return null;
  const rec = node as { type?: string; bodyRightCoverage?: number[]; children?: unknown[] };
  if (rec.type === "chrome_frame") return rec;
  if (!Array.isArray(rec.children)) return null;
  for (const child of rec.children) {
    const found = findChromeFrame(child);
    if (found !== null) return found;
  }
  return null;
}
