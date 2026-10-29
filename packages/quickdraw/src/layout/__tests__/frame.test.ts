import { expect, test } from "vitest";

import { clear, createBuffer, type Style } from "../../buffer/index.js";
import { FgP } from "../../lexicon/index.js";
import {
  attuneTheme,
  birthLive,
  collectLiveDemand,
  collectProgressSites,
  easeInOutCubic,
  elementAt,
  formatElapsedCompact,
  indicationGutterLines,
  layout,
  paintFrame,
  paintTheme,
  progressBarLive,
  formatContextOccupancy,
  formatHeldStatusFit,
  formatRemainingSpelled,
  formatTokenCount,
  quotaLive,
  resolveLiveText,
  spinnerLive,
  stepProgressBar,
  wrapText,
  type Frame,
  type IndicationNode,
  type LayoutNode,
  type PaintOp,
} from "../index.js";

function opStyle(op: PaintOp | undefined): Style | undefined {
  return op === undefined || op.kind === "raw" ? undefined : op.style;
}

function textLines(frame: Frame): string[] {
  return frame.paintOrder.flatMap((p) => p.paint.flatMap((op) => (op.kind === "text" ? op.lines : [])));
}

test("frame geometry, wrap, viewport, overlay, and border merge", () => {
  const row = layout(
    {
      type: "flex",
      style: { direction: "row", gap: 1 },
      children: [
        {
          type: "box",
          key: "a",
          style: { width: 5, height: 1 },
          intent: "activate",
          children: [{ type: "text", content: "hello" }],
        },
        {
          type: "box",
          key: "b",
          style: { width: 5, height: 1, flex: 1 },
          intent: "activate",
          children: [{ type: "text", content: "world" }],
        },
      ],
    },
    { w: 20, h: 5 },
  );

  const column = layout(
    {
      type: "flex",
      style: {
        direction: "column",
        justifyContent: "space_between",
        width: 10,
        height: 10,
      },
      children: [
        {
          type: "box",
          key: "top",
          style: { width: 10, height: 2 },
          children: [{ type: "text", content: "A" }],
        },
        {
          type: "box",
          key: "bot",
          style: { width: 10, height: 2 },
          children: [{ type: "text", content: "B" }],
        },
      ],
    },
    { w: 10, h: 10 },
  );

  const rowFlush = layout(
    {
      type: "flex",
      style: {
        direction: "row",
        justifyContent: "space_between",
        gap: 0,
      },
      children: [
        {
          type: "box",
          key: "a",
          style: { width: 1, height: 1 },
          children: [{ type: "text", content: "A" }],
        },
        {
          type: "box",
          key: "b",
          style: { width: 1, height: 1 },
          children: [{ type: "text", content: "B" }],
        },
        {
          type: "box",
          key: "c",
          style: { width: 1, height: 1 },
          children: [{ type: "text", content: "C" }],
        },
      ],
    },
    { w: 10, h: 1 },
  );
  const flushC = rowFlush.byKey.get("c")!;

  const btn = layout(
    {
      type: "box",
      key: "btn",
      style: { width: 10, height: 3 },
      intent: "activate",
      onClick: { type: "press" },
      children: [{ type: "text", content: "OK" }],
    },
    { w: 20, h: 10 },
  );
  const hit = elementAt(btn, 1, 1);

  const wrap = layout(
    {
      type: "text",
      key: "clamp",
      content: "one two three four five",
      lineClamp: 2,
    },
    { w: 8, h: 5 },
  );
  const wrapLines = textLines(wrap);

  const vpChildren = Array.from({ length: 10 }, (_, i) => ({
    type: "text" as const,
    content: `line-${i}`,
    key: `l${i}`,
  }));
  const autoTail = textLines(
    layout({ type: "viewport", id: "vp", overflowAnchor: "auto", children: vpChildren }, { w: 20, h: 3 }),
  );
  const noneScroll = textLines(
    layout(
      {
        type: "viewport",
        id: "vp",
        overflowAnchor: "none",
        scroll: 2,
        children: vpChildren,
      },
      { w: 20, h: 3 },
    ),
  );
  const topClip = textLines(
    layout(
      {
        type: "viewport",
        id: "vp",
        overflowAnchor: "none",
        scroll: 1,
        children: [{ type: "text", content: "aaaa bbbb cccc dddd eeee", key: "tall" }],
      },
      { w: 4, h: 2 },
    ),
  );

  const borderFrame = layout({ type: "box", style: { border: true, width: 6, height: 3 } }, { w: 10, h: 5 });
  const borderOps = borderFrame.paintOrder.flatMap((p) => p.paint.filter((op) => op.kind === "border"));

  const dimBackdrop = layout(
    {
      type: "box",
      children: [
        {
          type: "text",
          content: "behind",
          key: "base",
          style: { role: "foreground" },
        },
        {
          type: "overlay",
          key: "ovl",
          backdrop: true,
          children: [
            {
              type: "text",
              content: "modal",
              key: "modal-body",
              style: { role: "foreground" },
            },
          ],
        },
      ],
    },
    { w: 20, h: 5 },
  );
  const dimFills = dimBackdrop.paintOrder.flatMap((p) => p.paint.filter((op) => op.kind === "fill"));
  const dimBase = dimBackdrop.paintOrder.filter((p) => p.key === "base").flatMap((p) => p.paint);
  const dimModal = dimBackdrop.paintOrder.filter((p) => p.key === "modal-body").flatMap((p) => p.paint);

  const paintedBackdrop = layout(
    {
      type: "box",
      children: [
        {
          type: "text",
          content: "behind",
          key: "base",
          style: { role: "foreground" },
        },
        {
          type: "overlay",
          key: "ovl",
          backdrop: true,
          backdropStyle: { bg: 236 },
          children: [{ type: "text", content: "modal" }],
        },
      ],
    },
    { w: 20, h: 5 },
  );
  const paintedFills = paintedBackdrop.paintOrder.flatMap((p) => p.paint.filter((op) => op.kind === "fill"));
  const paintedBase = paintedBackdrop.paintOrder.filter((p) => p.key === "base").flatMap((p) => p.paint);

  const overlaySibling = layout(
    {
      type: "box",
      style: { width: 40, height: 12 },
      children: [
        {
          type: "box",
          key: "under",
          style: { width: 40, height: 12 },
          children: [{ type: "text", content: "under" }],
        },
        {
          type: "overlay",
          key: "ovl",
          center: true,
          backdrop: true,
          backdropStyle: { bg: 236 },
          children: [
            {
              type: "box",
              key: "pick",
              intent: "activate",
              style: {
                border: true,
                width: 14,
                height: 4,
                background: { bg: 235 },
              },
              children: [{ type: "text", content: "Select an LLM", key: "pick-body" }],
            },
          ],
        },
      ],
    },
    { w: 40, h: 12 },
  );
  const pick = overlaySibling.byKey.get("pick")!;

  const panelFrame = layout(
    {
      type: "overlay",
      center: true,
      backdrop: true,
      backdropStyle: { bg: 236 },
      children: [
        {
          type: "box",
          key: "panel",
          style: {
            border: true,
            width: 12,
            height: 5,
            background: { bg: 235 },
          },
          children: [{ type: "text", content: "ok" }],
        },
      ],
    },
    { w: 40, h: 12 },
  );
  const panel = panelFrame.byKey.get("panel")!;
  const panelBuf = createBuffer(40, 12);
  paintFrame(panelFrame, panelBuf);
  const corner = panelBuf.cells[panel.hitRect.y * 40 + panel.hitRect.x]!.style.bg;
  const inner = panelBuf.cells[(panel.hitRect.y + 1) * 40 + (panel.hitRect.x + 1)]!.style.bg;

  expect({
    row: { aW: row.byKey.get("a")?.hitRect.w, paints: row.paintOrder.length > 0 },
    columnPins: {
      topY: column.byKey.get("top")?.hitRect.y,
      botY: column.byKey.get("bot")?.hitRect.y,
    },
    rowFlush: {
      aX: rowFlush.byKey.get("a")?.hitRect.x,
      lastEnd: flushC.hitRect.x + flushC.hitRect.w,
    },
    hit: { key: hit?.key, intent: hit?.meta.intent },
  }).toEqual({
    row: { aW: 5, paints: true },
    columnPins: { topY: 0, botY: 8 },
    rowFlush: { aX: 0, lastEnd: 10 },
    hit: { key: "btn", intent: "activate" },
  });
  expect({
    wrap: {
      n: wrapLines.length,
      ellipsis: wrapLines[1]?.endsWith("…") === true,
    },
    autoTail: {
      hasLast: autoTail.includes("line-9"),
      hasFirst: autoTail.includes("line-0"),
    },
    noneScroll: {
      has2: noneScroll.includes("line-2"),
      has4: noneScroll.includes("line-4"),
      has0: noneScroll.includes("line-0"),
      has9: noneScroll.includes("line-9"),
    },
    topClip,
  }).toEqual({
    wrap: { n: 2, ellipsis: true },
    autoTail: { hasLast: true, hasFirst: false },
    noneScroll: { has2: true, has4: true, has0: false, has9: false },
    topClip: ["bbbb", "cccc"],
  });
  expect({
    border: {
      n: borderOps.length,
      style: opStyle(borderOps[0]),
    },
    dim: {
      fills: dimFills.length,
      baseRegion: dimBase.map((op) => opStyle(op)?.regionProminence),
      modalRegion: dimModal.map((op) => opStyle(op)?.regionProminence),
      backdropHit: dimBackdrop.byKey.has("ovl:backdrop"),
    },
    painted: {
      fills: paintedFills.length,
      fillBg: opStyle(paintedFills[0])?.bg,
      baseRegion: paintedBase.map((op) => opStyle(op)?.regionProminence),
    },
    overlay: {
      key: elementAt(overlaySibling, pick.hitRect.x + 1, pick.hitRect.y + 1)?.key,
      h: pick.hitRect.h,
      painted: overlaySibling.paintOrder.some((p) => p.key === "pick-body"),
    },
    panelFill: { corner, inner },
  }).toEqual({
    border: {
      n: 1,
      style: { role: "border", prominence: FgP.ghost },
    },
    dim: {
      fills: 0,
      baseRegion: [0.4],
      modalRegion: [undefined],
      backdropHit: true,
    },
    painted: {
      fills: 1,
      fillBg: 236,
      baseRegion: [undefined],
    },
    overlay: { key: "pick", h: 4, painted: true },
    panelFill: { corner: 235, inner: 235 },
  });
});

test("nested backdrop overlays multiply region dim", () => {
  const frame = layout(
    {
      type: "box",
      children: [
        { type: "text", content: "tape", key: "tape", style: { role: "foreground" } },
        {
          type: "overlay",
          key: "drawer",
          backdrop: true,
          children: [
            { type: "text", content: "side", key: "side", style: { role: "foreground" } },
            {
              type: "overlay",
              key: "peek",
              backdrop: true,
              children: [{ type: "text", content: "modal", key: "modal", style: { role: "foreground" } }],
            },
          ],
        },
      ],
    },
    { w: 20, h: 5 },
  );
  const region = (key: string) =>
    frame.paintOrder
      .filter((pos) => pos.key === key)
      .flatMap((pos) => pos.paint.map((op) => opStyle(op)?.regionProminence));
  expect({
    tape: region("tape"),
    side: region("side"),
    modal: region("modal"),
  }).toEqual({
    tape: [0.4 * 0.4],
    side: [0.4],
    modal: [undefined],
  });
});

test("overlay origin seats the child at overlay-local x,y", () => {
  const frame = layout(
    {
      type: "box",
      style: { width: 20, height: 10 },
      children: [
        {
          type: "overlay",
          key: "ovl",
          origin: { x: 5, y: 3 },
          children: [
            {
              type: "box",
              key: "plaque",
              style: { width: 4, height: 2 },
              children: [{ type: "text", content: "hi" }],
            },
          ],
        },
      ],
    },
    { w: 20, h: 10 },
  );
  const plaque = frame.byKey.get("plaque")!;
  expect(plaque.hitRect).toEqual({ x: 5, y: 3, w: 4, h: 2 });
});

test.each([
  {
    name: "normal hard-newline",
    input: "hello\nworld",
    opts: { width: 40 },
    lines: ["hello", "world"],
  },
  {
    name: "normal blank line",
    input: "hello\n\nworld",
    opts: { width: 40 },
    lines: ["hello", "", "world"],
  },
  {
    name: "normal collapse double space",
    input: "a  b",
    opts: { width: 40 },
    lines: ["a b"],
  },
  {
    name: "normal keeps edge spaces",
    input: " from ",
    opts: { width: 40 },
    lines: [" from "],
  },
  {
    name: "normal keeps trailing word space",
    input: "hello from ",
    opts: { width: 40 },
    lines: ["hello from "],
  },
  {
    name: "pre-wrap preserves spaces",
    input: "a  b",
    opts: { width: 40, whiteSpace: "pre-wrap" as const },
    lines: ["a  b"],
  },
  {
    name: "pre-wrap hard newline",
    input: "hello\nworld",
    opts: { width: 40, whiteSpace: "pre-wrap" as const },
    lines: ["hello", "world"],
  },
  {
    name: "pre-wrap trailing newline",
    input: "hi\n",
    opts: { width: 40, whiteSpace: "pre-wrap" as const },
    lines: ["hi", ""],
  },
  {
    name: "pre-wrap soft-wrap keeps spaces",
    input: "aa  bb  cc",
    opts: { width: 5, whiteSpace: "pre-wrap" as const },
    lines: ["aa  ", "bb  ", "cc"],
  },
  {
    name: "pre-wrap prefers last space",
    input: "hello world",
    opts: { width: 8, whiteSpace: "pre-wrap" as const },
    lines: ["hello ", "world"],
  },
  {
    name: "normal prefers last space",
    input: "hello world",
    opts: { width: 8 },
    lines: ["hello", "world"],
  },
] as const)("whitespace $name", ({ input, opts, lines }) => {
  expect(wrapText(input, opts)).toEqual([...lines]);
});

test("indication furniture is not body", () => {
  const quoted = layout(
    {
      type: "indication",
      key: "bq",
      gutter: { kind: "rule", glyph: "|" },
      style: { role: "border", prominence: FgP.ghost },
      children: [
        {
          type: "text",
          content: "quoted",
          key: "q",
          style: { role: "foreground", prominence: FgP.secondary },
        },
      ],
    },
    { w: 20, h: 2 },
  );
  const gutterOp = quoted.paintOrder.find((p) => p.key === "bq:glyph")?.paint[0];
  const bodyOp = quoted.paintOrder.find((p) => p.key === "q")?.paint[0];

  const rule = layout(
    {
      type: "indication",
      key: "bq",
      gutter: { kind: "rule", glyph: "|" },
      children: [
        { type: "text", content: "first", key: "a" },
        { type: "text", content: "second", key: "b" },
        { type: "text", content: "third", key: "c" },
      ],
    },
    { w: 20, h: 5 },
  );
  const ruleGlyph = rule.paintOrder.find((p) => p.key === "bq:glyph")?.paint[0];
  const ruleLines = ruleGlyph?.kind === "text" ? ruleGlyph.lines : [];

  const top = layout(
    {
      type: "indication",
      key: "composer",
      gutter: { kind: "top", glyph: ">" },
      children: [
        {
          type: "text",
          content: "hi\nworld",
          whiteSpace: "pre-wrap",
          key: "body",
        },
      ],
    },
    { w: 20, h: 4 },
  );
  const topGlyph = top.paintOrder.find((p) => p.key === "composer:glyph")?.paint[0];
  const topLines = topGlyph?.kind === "text" ? topGlyph.lines : [];
  const topBody = top.paintOrder.find((p) => p.key === "body")?.paint[0];

  const closedNode: IndicationNode = {
    type: "indication",
    key: "thought",
    gutter: { kind: "corners", top: "T", mid: "M", bottom: "B" },
    children: [
      { type: "text", content: "a", key: "a" },
      { type: "text", content: "b", key: "b" },
      { type: "text", content: "c", key: "c" },
    ],
  };
  const openNode: IndicationNode = {
    type: "indication",
    key: "live",
    gutter: { kind: "corners", top: "T", mid: "M", bottom: null },
    children: [
      { type: "text", content: "a", key: "a" },
      { type: "text", content: "b", key: "b" },
    ],
  };
  const closedLines = indicationGutterLines(closedNode, 3);
  const openLines = indicationGutterLines(openNode, 3);

  const bleed = layout(
    {
      type: "indentation_exception",
      kind: "diff",
      key: "d1",
      children: [{ type: "text", content: "+line", key: "diff-line" }],
    },
    { w: 20, h: 2 },
  );
  const bleedOp = bleed.paintOrder.find((p) => p.key === "diff-line")?.paint[0];

  expect({
    furniture: {
      gutter: {
        kind: "rule",
        role: opStyle(gutterOp)?.role,
        prominence: opStyle(gutterOp)?.prominence,
        bold: opStyle(gutterOp)?.bold === true,
      },
      body: {
        role: opStyle(bodyOp)?.role,
        prominence: opStyle(bodyOp)?.prominence,
        x: bodyOp?.rect.x,
      },
    },
    ruleEveryRow: {
      kind: "rule",
      filled: ruleLines.map((l) => l.trim().length > 0),
      bodyX: rule.paintOrder.find((p) => p.key === "a")?.paint[0]?.rect.x,
    },
    topFirstOnly: {
      kind: "top",
      firstFilled: (topLines[0] ?? "").trim().length > 0,
      restEmpty: topLines.slice(1).every((l) => l.trim() === ""),
      bodyX: topBody?.rect.x,
    },
    corners: {
      closedKind: closedNode.gutter.kind,
      openKind: openNode.gutter.kind,
      closedLastDiffersFromMid: closedLines[2] !== closedLines[1],
      openLastEqualsMid: openLines[2] === openLines[1],
    },
    exceptionX: bleedOp?.rect.x,
  }).toEqual({
    furniture: {
      gutter: {
        kind: "rule",
        role: "border",
        prominence: FgP.ghost,
        bold: false,
      },
      body: { role: "foreground", prominence: FgP.secondary, x: 3 },
    },
    ruleEveryRow: { kind: "rule", filled: [true, true, true], bodyX: 3 },
    topFirstOnly: {
      kind: "top",
      firstFilled: true,
      restEmpty: true,
      bodyX: 3,
    },
    corners: {
      closedKind: "corners",
      openKind: "corners",
      closedLastDiffersFromMid: true,
      openLastEqualsMid: true,
    },
    exceptionX: 0,
  });
});

test("live demand, spinner clock, collapse, and birth W", () => {
  const spinnerTree: LayoutNode = {
    type: "indication",
    key: "t",
    gutter: { kind: "spinner", profile: "thinking" },
    children: [{ type: "text", content: "thinking", key: "b" }],
  };
  const spinnerFrame = layout(spinnerTree, { w: 40, h: 5 });
  const demand = collectLiveDemand(spinnerFrame.paintOrder);
  const a = createBuffer(20, 3);
  const b = createBuffer(20, 3);
  clear(a);
  clear(b);
  const spinPaint = layout(spinnerTree, { w: 20, h: 3 });
  paintFrame(spinPaint, a, undefined, { nowMs: 0 });
  paintFrame(spinPaint, b, undefined, { nowMs: 500 });

  const disclosure: LayoutNode = {
    type: "disclosure",
    key: "d",
    collapsed: true,
    intent: "activate",
    onClick: { type: "toggle_collapsed", blockId: "d" },
    summary: { type: "text", content: "sum", key: "s" },
    children: [
      { type: "text", content: "hidden", key: "b1" },
      { type: "text", content: "body", key: "b2" },
    ],
  };
  const collapsed = layout(disclosure, { w: 40, h: 8 });
  const open = layout({ ...disclosure, collapsed: false }, { w: 40, h: 8 });

  const birthTree: LayoutNode = {
    type: "text",
    key: "tip",
    content: "abcdefghij",
    live: birthLive({
      siteId: "s1",
      T: 10,
      offset: 0,
      target: 1,
      birthFloor: 0.12,
      falloff: 0.8,
      tipWindow: 12,
    }),
  };
  const birthFrame = layout(birthTree, { w: 20, h: 2 });
  const rest = createBuffer(20, 2);
  const early = createBuffer(20, 2);
  clear(rest);
  clear(early);
  paintFrame(birthFrame, rest, undefined, { nowMs: 0 });
  paintFrame(birthFrame, early, undefined, {
    nowMs: 16,
    birth: new Map([["s1", 2]]),
  });

  expect({
    demand: {
      maxHz: spinnerFrame.liveDemand?.maxHz,
      spinners: spinnerFrame.liveDemand?.spinners,
      collected: demand.spinners,
    },
    clock: {
      advanced:
        resolveLiveText({ kind: "spinner", profile: "thinking", hz: 12 }, 0) !==
        resolveLiveText({ kind: "spinner", profile: "thinking", hz: 12 }, 500),
      ch0: a.cells[1]?.ch,
      ch1: b.cells[1]?.ch,
      resolved0: resolveLiveText({ kind: "spinner", profile: "thinking", hz: 12 }, 0),
      resolved500: resolveLiveText({ kind: "spinner", profile: "thinking", hz: 12 }, 500),
    },
    spinnerLive: {
      thinkingHz: spinnerLive("thinking").hz,
      workingProfile: spinnerLive("working").profile,
    },
    collapse: {
      click: collapsed.byKey.get("d")?.onClick,
      hit: collapsed.hitList.some((h) => h.key === "d"),
      collapsedHasSummary: collapsed.paintOrder.some((p) => p.key === "s"),
      collapsedHasBody: collapsed.paintOrder.some((p) => p.key === "b1" || p.key === "b2"),
      openHasBody: open.paintOrder.some((p) => p.key === "b1"),
    },
    birth: {
      demand: collectLiveDemand(birthFrame.paintOrder),
      maxHz: birthFrame.liveDemand?.maxHz,
      waveMoved: early.cells[7]!.style.prominence !== rest.cells[7]!.style.prominence,
    },
  }).toEqual({
    demand: {
      maxHz: 12,
      spinners: 1,
      collected: 1,
    },
    clock: {
      advanced: true,
      ch0: resolveLiveText({ kind: "spinner", profile: "thinking", hz: 12 }, 0),
      ch1: resolveLiveText({ kind: "spinner", profile: "thinking", hz: 12 }, 500),
      resolved0: resolveLiveText({ kind: "spinner", profile: "thinking", hz: 12 }, 0),
      resolved500: resolveLiveText({ kind: "spinner", profile: "thinking", hz: 12 }, 500),
    },
    spinnerLive: { thinkingHz: 12, workingProfile: "working" },
    collapse: {
      click: { type: "toggle_collapsed", blockId: "d" },
      hit: true,
      collapsedHasSummary: true,
      collapsedHasBody: false,
      openHasBody: true,
    },
    birth: {
      demand: { maxHz: 0, spinners: 0, elapsed: 0, quota: 0, birth: 1 },
      maxHz: 0,
      waveMoved: true,
    },
  });
});

test("quota remaining is painted from resetAt, not a frozen string", () => {
  const live = quotaLive([{ remainingPercent: 67, resetAt: 90 * 60 }]);
  expect({
    hours: resolveLiveText(quotaLive([{ remainingPercent: 67, resetAt: 7200 }]), 0),
    occupancy: {
      compact: formatContextOccupancy(10_000, 500_000),
      empty: formatContextOccupancy(0, 0),
      counts: [formatTokenCount(999), formatTokenCount(1_500), formatTokenCount(10_000)],
    },
    withOccupancy: resolveLiveText(quotaLive([{ remainingPercent: 51, resetAt: 5 * 3600 }], { prefix: "10k/500k" }), 0),
    fit: {
      wide: formatHeldStatusFit("10k/500k", [{ remainingPercent: 51, resetAt: 5 * 3600 }], 0, 40, (t) => t.length),
      narrow: formatHeldStatusFit("10k/500k", [{ remainingPercent: 51, resetAt: 5 * 3600 }], 0, 12, (t) => t.length),
      tighter: formatHeldStatusFit("10k/500k", [{ remainingPercent: 51, resetAt: 5 * 3600 }], 0, 4, (t) => t.length),
    },
    minutes: resolveLiveText(live, 0),
    later: resolveLiveText(live, 61_000),
    spelled: {
      minutes: formatRemainingSpelled(23 * 60 * 1000),
      hoursAndMinutes: formatRemainingSpelled((2 * 3600 + 10 * 60) * 1000),
      skipLeftoverMinute: formatRemainingSpelled((2 * 3600 + 60) * 1000),
      roundUp: formatRemainingSpelled((2 * 3600 - 60) * 1000),
      daysAndHours: formatRemainingSpelled((3 * 86400 + 4 * 3600) * 1000),
      one: formatRemainingSpelled(60 * 1000),
    },
  }).toEqual({
    hours: "67% left for 2 hours",
    occupancy: { compact: "10k/500k", empty: "", counts: ["999", "1.5k", "10k"] },
    withOccupancy: "10k/500k · 51% left for 5 hours",
    fit: {
      wide: "10k/500k · 51% left for 5 hours",
      narrow: "10k/500k",
      tighter: "10k/500k · 51% left for 5 hours",
    },
    minutes: "67% left for 1 hour and 30 minutes",
    later: "67% left for 1 hour and 29 minutes",
    spelled: {
      minutes: "23 minutes",
      hoursAndMinutes: "2 hours and 10 minutes",
      skipLeftoverMinute: "2 hours",
      roundUp: "2 hours",
      daysAndHours: "3 days and 4 hours",
      one: "1 minute",
    },
  });
});

test("expired quota percentages disappear until a fresh snapshot arrives", () => {
  const resetAt = 5 * 3600;
  const nowMs = resetAt * 1000;
  const weekly = { remainingPercent: 18, resetAt: resetAt + 2 * 86400 + 12 * 3600 };
  const live = quotaLive([{ remainingPercent: 9, resetAt }, weekly]);

  expect(resolveLiveText(live, nowMs)).toBe("18% left for 2 days and 12 hours");
  expect(resolveLiveText(live, nowMs + 1000)).toBe("18% left for 2 days and 12 hours");
  expect(resolveLiveText(quotaLive([{ remainingPercent: 9, resetAt }]), nowMs)).toBe("");
  expect(resolveLiveText(quotaLive([{ remainingPercent: 9, resetAt }], { prefix: "10k/500k" }), nowMs)).toBe(
    "10k/500k",
  );
  // An unknown deadline is not evidence that the window has expired.
  expect(resolveLiveText(quotaLive([{ remainingPercent: 9 }]), nowMs)).toBe("9%");
  expect(resolveLiveText(quotaLive([{ remainingPercent: 9, resetAt }]), nowMs - 1000)).toBe("9% left for 1 minute");
  expect(
    resolveLiveText(
      quotaLive([
        { remainingPercent: 100, resetAt: resetAt + 5 * 3600 },
        { ...weekly, remainingPercent: 17 },
      ]),
      nowMs,
    ),
  ).toBe("100% left for 5 hours · 17% left for 2 days and 12 hours");
});

test("elapsed live keeps a tenths place", () => {
  expect({
    whole: formatElapsedCompact(3000),
    frac: formatElapsedCompact(3400),
    ten: formatElapsedCompact(10_000),
    label: resolveLiveText({ kind: "elapsed", startedAt: 0, hz: 1 }, 3000),
    waiting: resolveLiveText({ kind: "elapsed", startedAt: 0, label: "waiting for response...", hz: 2 }, 3000),
  }).toEqual({
    whole: "3.0s",
    frac: "3.4s",
    ten: "10.0s",
    label: "thinking · 3.0s",
    waiting: "waiting for response... · 3.0s",
  });
});

test("countdown live spells remaining seconds", () => {
  expect({
    many: resolveLiveText({ kind: "countdown", untilMs: 5_000, hz: 2 }, 0),
    one: resolveLiveText({ kind: "countdown", untilMs: 1_000, hz: 2 }, 0),
    due: resolveLiveText({ kind: "countdown", untilMs: 0, hz: 2 }, 500),
  }).toEqual({
    many: "Failed to request; retrying in 5 seconds",
    one: "Failed to request; retrying in 1 second",
    due: "Failed to request; retrying in 0 seconds",
  });
});

test("attuneTheme does not mutate ambient and guesses depth from env", () => {
  const probe = { role: "foreground" as const };
  const before = paintTheme().resolveStyle(probe);
  const binding = attuneTheme({ ground: 0.85, depth: "truecolor" });
  const ambientAfter = paintTheme().resolveStyle(probe);

  const prev = process.env.COLORTERM;
  const prevNo = process.env.NO_COLOR;
  let depthTruecolor: string | undefined;
  let depthMono: string | undefined;
  try {
    delete process.env.NO_COLOR;
    process.env.COLORTERM = "truecolor";
    depthTruecolor = attuneTheme({ ground: 0.2 }).depth;
    process.env.NO_COLOR = "1";
    depthMono = attuneTheme({ ground: 0.2 }).depth;
  } finally {
    if (prev === undefined) delete process.env.COLORTERM;
    else process.env.COLORTERM = prev;
    if (prevNo === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = prevNo;
  }

  expect(binding.theme.ground).toBeCloseTo(0.85, 5);
  expect({ ambientAfter, depthTruecolor, depthMono }).toEqual({
    ambientAfter: before,
    depthTruecolor: "truecolor",
    depthMono: "mono",
  });
});

test("progress ease identity, snap, and picker skip", () => {
  const snap = stepProgressBar(undefined, 0.4, undefined, 0);
  const start = stepProgressBar(undefined, 0, undefined, 0);
  const retarget = stepProgressBar(start, 1, undefined, 10);
  const mid = stepProgressBar(retarget, 1, undefined, 10 + 120);
  const end = stepProgressBar(retarget, 1, undefined, 10 + 240);
  const tree: LayoutNode = {
    type: "box",
    children: [
      {
        type: "chrome_frame",
        key: "slash-complete",
        width: 40,
        draft: "",
        plainBottom: true,
      },
      {
        type: "chrome_frame",
        key: "composer:frame",
        width: 40,
        draft: "",
        progress: 0.3,
      },
    ],
  };

  expect({
    identity: [easeInOutCubic(0), easeInOutCubic(1), easeInOutCubic(0.5)],
    slow: {
      early: easeInOutCubic(0.15) < 0.15,
      late: 1 - easeInOutCubic(0.85) < 0.15,
    },
    snap: { displayed: snap.displayed, live: progressBarLive(snap) },
    retarget: { from: retarget.from, to: retarget.to },
    mid: {
      inFlight: mid.displayed > 0.2 && mid.displayed < 0.8,
      live: progressBarLive(mid),
    },
    end: { displayed: end.displayed, live: progressBarLive(end) },
    sites: collectProgressSites(tree),
  }).toEqual({
    identity: [0, 1, 0.5],
    slow: { early: true, late: true },
    snap: { displayed: 0.4, live: false },
    retarget: { from: 0, to: 1 },
    mid: { inFlight: true, live: true },
    end: { displayed: 1, live: false },
    sites: [{ key: "composer:frame", progress: 0.3 }],
  });
});
