import { expect, test } from "vitest";

import { FgP } from "../../lexicon/index.js";
import {
  CHROME_FRAME_DEFAULT_GLYPH,
  CHROME_FRAME_DEFAULT_PROGRESS_ROLE,
  CHROME_FRAME_JOIN,
  chromeFrameBodyFromContentSegs,
  chromeFrameBodyLines,
  chromeFrameBottomSegs,
  chromeFramePaintOps,
  chromeFrameTextWidth,
  chromeFrameTopSegs,
  chromeFrameTotalHeight,
  measureChromeFrame,
  progressFillSegments,
  progressGlowTint,
  progressRampProminence,
  type ChromeSeg,
} from "../chrome_frame.js";
import { containRegionAt, layout } from "../engine.js";
import { expandToLineAt, extendSelection, rowRange, startSelection } from "../selection.js";
import { wrapText } from "../text.js";
import type { LayoutNode, PaintOp } from "../types.js";

function voice(segs: ChromeSeg[], match: string | ((text: string) => boolean)) {
  const pred = typeof match === "string" ? (text: string) => text === match : match;
  const seg = segs.find((s) => pred(s.text));
  return seg ? { role: seg.style.role, prominence: seg.style.prominence, bold: seg.style.bold } : null;
}

function hueRoles(segs: ChromeSeg[]): string[] {
  return [...new Set(segs.map((s) => s.style.role).filter((role): role is string => !!role && role !== "foreground"))];
}

test("chrome geometry + contain + progress partition", () => {
  expect({
    textW: chromeFrameTextWidth(40),
    totalH: chromeFrameTotalHeight(1),
    emptyDraft: chromeFrameBodyLines("", 40),
  }).toEqual({
    textW: 36,
    totalH: 3,
    emptyDraft: [" "],
  });

  const bodySegs = chromeFrameBodyFromContentSegs([{ text: "LM Studio", style: {} }], 40, { glyph: "›" });
  const counted = chromeFrameBodyFromContentSegs([{ text: "Keep AUTH_SECRET", style: {} }], 40, { glyph: "1" });
  expect({
    prefix: bodySegs.slice(0, 3).map((s) => s.text),
    contentBudget: chromeFrameTextWidth(40),
    label: bodySegs[3]!.text.startsWith("LM Studio"),
    chevron: voice(bodySegs, "›"),
    counterPrefix: counted.slice(0, 3).map((s) => s.text),
    counter: voice(counted, "1"),
  }).toEqual({
    prefix: ["│", "›", " "],
    contentBudget: 36,
    label: true,
    chevron: { role: "foreground", prominence: FgP.primary, bold: true },
    counterPrefix: ["│", "1", " "],
    counter: { role: "muted", prominence: FgP.ghost, bold: undefined },
  });

  const joined = chromeFrameBottomSegs(20, { plain: true, join: true });
  const joinedTop = chromeFrameTopSegs(20, null, { join: true });
  expect({
    left: joined[0]!.text,
    right: joined[joined.length - 1]!.text,
    topLeft: joinedTop[0]!.text,
    topRight: joinedTop[joinedTop.length - 1]!.text,
  }).toEqual({
    left: CHROME_FRAME_JOIN.left,
    right: CHROME_FRAME_JOIN.right,
    topLeft: CHROME_FRAME_JOIN.left,
    topRight: CHROME_FRAME_JOIN.right,
  });

  const half = progressFillSegments(20, 0.5);
  const frac = progressFillSegments(20, 0.525);
  const full = progressFillSegments(10, 1);
  expect({
    half,
    frac: { ...frac, frac: +frac.frac.toFixed(5) },
    full,
    ramp: [progressRampProminence(0), progressRampProminence(0.5), progressRampProminence(1)],
    rampMono: progressRampProminence(0.8) > progressRampProminence(0.2),
    glow: [
      progressGlowTint(1, 0.75),
      progressGlowTint(0.75, 0.75),
      progressGlowTint(0.375, 0.75),
      progressGlowTint(0, 0.75),
    ],
  }).toEqual({
    half: { full: 10, frac: 0, rest: 10, total: 20 },
    frac: { full: 10, frac: 0.5, rest: 9, total: 20 },
    full: { full: 10, frac: 0, rest: 0, total: 10 },
    ramp: [0, FgP.primary * 0.5, FgP.primary],
    rampMono: true,
    glow: [0, 0, 0.5, 1],
  });

  const omitted = chromeFrameBottomSegs(40, { statusItems: ["act"] });
  const warning = chromeFrameBottomSegs(40, { progress: 0.5, progressRole: "warning" });
  const defFill = chromeFrameBottomSegs(40, { progress: 0.5 });
  expect({
    omittedHues: hueRoles(omitted),
    omittedRoles: [...new Set(omitted.map((s) => s.style.role ?? "foreground"))],
    warningHues: hueRoles(warning),
    defaultHues: hueRoles(defFill),
    defaultRole: CHROME_FRAME_DEFAULT_PROGRESS_ROLE,
  }).toEqual({
    omittedHues: [],
    omittedRoles: ["foreground"],
    warningHues: ["warning"],
    defaultHues: [],
    defaultRole: "foreground",
  });

  const healthy = chromeFrameBottomSegs(40, { progress: 1 });
  const warming = chromeFrameBottomSegs(40, { progress: 0.35 });
  const tintOf = (segs: ChromeSeg[]) => segs.find((s) => typeof s.style.tint === "number")?.style ?? {};
  const yielded = chromeFrameBottomSegs(40, {
    progress: 0.35,
    contourRole: "emphasis",
  });
  expect({
    healthyTint: tintOf(healthy).tint ?? 0,
    healthyHue: hueRoles(healthy),
    warmingTint: (tintOf(warming).tint ?? 0) > 0,
    warmingRole: tintOf(warming).tintRole ?? "",
    warmingFill: hueRoles(warming),
    yieldedTint: tintOf(yielded).tint ?? 0,
    yieldedHue: hueRoles(yielded),
  }).toEqual({
    healthyTint: 0,
    healthyHue: [],
    warmingTint: true,
    warmingRole: "warning",
    warmingFill: [],
    yieldedTint: 0,
    yieldedHue: ["emphasis"],
  });

  const top = chromeFrameTopSegs(
    48,
    [
      { key: "Enter", action: "send" },
      { key: "Esc", action: "cancel" },
    ],
    { annotation: "idle" },
  );
  const coverAnn = chromeFrameTopSegs(
    48,
    [
      { key: "Enter", action: "Allow" },
      { key: "Esc", action: "Deny" },
    ],
    {
      annotation: "edit **a.ts**",
    },
  );
  const bot = chromeFrameBottomSegs(40, { statusItems: ["act"] });
  const auto = chromeFrameBottomSegs(40, {
    statusItems: ["llama3", { text: "auto", role: "auto" }],
  });
  const attention = chromeFrameBottomSegs(40, {
    statusItems: [{ text: "always approve", role: "attention" }],
  });
  const tinted = chromeFrameBottomSegs(40, { contourRole: "warning" });
  expect({
    enter: voice(top, "⏎"),
    send: voice(top, (t) => t.includes("send")),
    esc: voice(top, "Esc"),
    cancel: voice(top, (t) => t.includes("cancel")),
    idle: voice(top, (t) => t.includes("idle")),
    coverVerb: voice(coverAnn, (t) => t.includes("edit")),
    coverFile: voice(coverAnn, "a.ts"),
    act: voice(bot, (t) => t.includes("act")),
    autoChip: voice(auto, (t) => t.includes("auto")),
    autoBox: voice(auto, "╰"),
    llama: voice(auto, (t) => t.includes("llama3")),
    attentionChip: voice(attention, (t) => t.includes("always approve")),
    attentionBox: voice(attention, "╰"),
    tintedBox: voice(tinted, "╰"),
  }).toEqual({
    enter: { role: "foreground", prominence: FgP.primary, bold: undefined },
    send: { role: "foreground", prominence: FgP.ghost, bold: undefined },
    esc: { role: "foreground", prominence: FgP.primary, bold: undefined },
    cancel: { role: "foreground", prominence: FgP.ghost, bold: undefined },
    idle: { role: "foreground", prominence: FgP.ghost, bold: undefined },
    coverVerb: { role: "foreground", prominence: FgP.ghost, bold: undefined },
    coverFile: { role: "foreground", prominence: FgP.primary, bold: false },
    act: { role: "foreground", prominence: FgP.ghost, bold: undefined },
    autoChip: { role: "auto", prominence: FgP.secondary, bold: undefined },
    autoBox: { role: "foreground", prominence: FgP.ghost, bold: undefined },
    llama: { role: "foreground", prominence: FgP.ghost, bold: undefined },
    attentionChip: { role: "attention", prominence: FgP.secondary, bold: undefined },
    attentionBox: { role: "foreground", prominence: FgP.ghost, bold: undefined },
    tintedBox: { role: "warning", prominence: FgP.ghost, bold: undefined },
  });

  const longFile = "generated-super-califragilistic-expialidocious-component-module.ts";
  const longAnn = chromeFrameTopSegs(
    48,
    [
      { key: "Enter", action: "Allow" },
      { key: "Esc", action: "Deny" },
    ],
    {
      annotation: `edit **${longFile}**`,
    },
  );
  const longTexts = new Set(longAnn.map((s) => s.text));
  const lineOf = (segs: ChromeSeg[]) => segs.map((s) => s.text).join("");
  const emptyTop = chromeFrameTopSegs(40, null);
  const emptyBot = chromeFrameBottomSegs(40, {});
  expect({
    hint: ["⏎", ": ", "Allow", " · ", "Esc", ": ", "Deny"].every((t) => longTexts.has(t)),
    file: [...longAnn].reverse().find((s) => s.text.includes("…"))?.text,
    topPad: lineOf(top).slice(-3),
    coverPad: lineOf(coverAnn).slice(-3),
    botPad: lineOf(bot).slice(-3),
    emptyTop: lineOf(emptyTop).slice(-2),
    emptyBot: lineOf(emptyBot).slice(-2),
  }).toEqual({
    hint: true,
    file: "gen…module.ts",
    topPad: " ─╮",
    coverPad: " ─╮",
    botPad: " ─╯",
    emptyTop: "─╮",
    emptyBot: "─╯",
  });

  const draft = "hi\nthere";
  const node = { type: "chrome_frame" as const, key: "c", width: 40, draft };
  const geom = measureChromeFrame(node, 40, 20);
  const wrapped = wrapText(draft, {
    width: chromeFrameTextWidth(40),
    whiteSpace: "pre-wrap",
  });
  expect({ bodyH: geom.bodyH, totalH: geom.totalH, glyph: geom.glyph }).toEqual({
    bodyH: wrapped.length,
    totalH: chromeFrameTotalHeight(wrapped.length),
    glyph: CHROME_FRAME_DEFAULT_GLYPH,
  });

  const composer = layout(
    { type: "chrome_frame", key: "composer", width: 30, draft: "hello\nworld" },
    { w: 40, h: 10 },
  );
  const body = composer.byKey.get("composer")!;
  expect({
    userSelect: body.userSelect,
    hit: body.hitRect,
    inside: containRegionAt(composer, body.hitRect.x + 1, body.hitRect.y),
    sideBar: containRegionAt(composer, 0, body.hitRect.y),
    rightBar: containRegionAt(composer, 29, body.hitRect.y),
    glyph: containRegionAt(composer, 2, body.hitRect.y),
  }).toEqual({
    userSelect: "contain",
    hit: { x: 3, y: 1, w: 26, h: 2 },
    inside: { key: "composer", rect: { x: 3, y: 1, w: 26, h: 2 } },
    sideBar: null,
    rightBar: null,
    glyph: null,
  });

  const emptyDraft = layout({ type: "chrome_frame", key: "composer", width: 30, draft: "" }, { w: 40, h: 10 });
  const emptyBody = emptyDraft.byKey.get("composer")!;
  expect({
    userSelect: emptyBody.userSelect,
    region: containRegionAt(emptyDraft, emptyBody.hitRect.x + 1, emptyBody.hitRect.y)?.key,
  }).toEqual({ userSelect: "contain", region: "composer" });

  const placeholder = layout(
    {
      type: "chrome_frame",
      key: "composer",
      width: 30,
      draft: "",
      placeholder: "type here",
    },
    { w: 40, h: 10 },
  );
  const phBody = placeholder.byKey.get("composer")!;
  expect({
    userSelect: phBody.userSelect,
    region: containRegionAt(placeholder, phBody.hitRect.x + 1, phBody.hitRect.y),
  }).toEqual({ userSelect: "none", region: null });

  const outside = layout({ type: "box", userSelect: "text", style: { width: 20, height: 5 } }, { w: 20, h: 5 });
  expect(containRegionAt(outside, 5, 2)).toEqual(null);

  const box = { x: 10, y: 5, w: 20, h: 3 };
  const contained = extendSelection(startSelection({ col: 12, row: 5 }, "char", "composer", box), {
    col: 50,
    row: 20,
  })!;
  expect({
    active: contained.active,
    mid: rowRange(contained, 6, 80),
    above: rowRange(contained, 0, 80),
    below: rowRange(contained, 10, 80),
  }).toEqual({
    active: { col: 29, row: 7 },
    mid: [10, 29],
    above: null,
    below: null,
  });

  const line = expandToLineAt({ col: 15, row: 6 }, 80, "composer", box);
  expect({
    anchor: line.anchor,
    active: line.active,
    contain: line.contain,
    cols: rowRange(line, 6, 80),
  }).toEqual({
    anchor: { col: 10, row: 6 },
    active: { col: 29, row: 6 },
    contain: box,
    cols: [10, 29],
  });

  const list: LayoutNode = {
    type: "chrome_frame",
    key: "list",
    width: 20,
    draft: "",
    bodyUserSelect: "none",
    bodySegRows: [[{ text: "/connect" }]],
  };
  const listed = layout(list, { w: 20, h: 10 });
  expect({
    body: listed.byKey.get("list")?.userSelect,
    chrome: listed.byKey.get("list:chrome")?.userSelect,
  }).toEqual({ body: "none", chrome: "none" });
});

test("non-interactive whispers the draft, not shortcut keys", () => {
  const { ops } = chromeFramePaintOps(
    {
      type: "chrome_frame",
      key: "cover",
      width: 48,
      draft: "shadowed",
      hotkeys: [
        { key: "Enter", action: "Allow" },
        { key: "Esc", action: "Deny" },
      ],
      interactive: false,
    },
    { x: 0, y: 0, w: 48, h: 5 },
  );
  const texts = ops.filter((op) => op.kind === "text");
  const voiceOf = (match: string) => {
    const op = texts.find((t) => t.lines[0] === match || t.lines[0]?.includes(match));
    return op ? { prominence: op.style.prominence, y: op.rect.y } : null;
  };
  expect({
    enter: voiceOf("⏎"),
    allow: voiceOf("Allow"),
    body: voiceOf("shadowed"),
  }).toEqual({
    enter: { prominence: FgP.primary, y: 0 },
    allow: { prominence: FgP.ghost, y: 0 },
    body: { prominence: FgP.whisper, y: 1 },
  });
  const enter = texts.find((t) => t.lines[0] === "⏎");
  const colon = texts.find((t) => t.lines[0] === ": ");
  expect({
    enterW: enter?.rect.w,
    colonX: colon && enter ? colon.rect.x - enter.rect.x : null,
  }).toEqual({ enterW: 2, colonX: 2 });
});

test("selected recap raises the contour; neighbors stay furniture", () => {
  const selected = chromeFramePaintOps(
    {
      type: "chrome_frame",
      key: "recap",
      width: 40,
      draft: "pin",
      readOnly: true,
      selected: true,
      plainBottom: true,
    },
    { x: 0, y: 0, w: 40, h: 4 },
  );
  const neighbor = chromeFramePaintOps(
    {
      type: "chrome_frame",
      key: "other",
      width: 40,
      draft: "other",
      readOnly: true,
      plainBottom: true,
    },
    { x: 0, y: 0, w: 40, h: 4 },
  );
  const corner = (ops: typeof selected.ops) =>
    ops.find(
      (op): op is Extract<PaintOp, { kind: "text" }> =>
        op.kind === "text" && (op.lines[0] === "╭" || op.lines[0]?.startsWith("╭")),
    );
  expect({
    selected: corner(selected.ops)?.style.prominence,
    neighbor: corner(neighbor.ops)?.style.prominence,
  }).toEqual({
    selected: FgP.primary,
    neighbor: FgP.ghost,
  });
});

test("read-only recap keeps ordinary body voice", () => {
  const { ops } = chromeFramePaintOps(
    {
      type: "chrome_frame",
      key: "recap",
      width: 48,
      draft: "rotate AUTH_SECRET",
      annotation: "Auth refactor",
      interactive: false,
      readOnly: true,
    },
    { x: 0, y: 0, w: 48, h: 5 },
  );
  const body = ops.filter((op) => op.kind === "text").find((t) => t.lines[0]?.includes("rotate AUTH_SECRET"));
  expect(body?.style.prominence).toBe(FgP.primary);
});

test("interactive draft is roman", () => {
  const { ops } = chromeFramePaintOps(
    { type: "chrome_frame", key: "c", width: 40, draft: "hello" },
    { x: 0, y: 0, w: 40, h: 5 },
  );
  const body = ops.filter((op) => op.kind === "text").find((t) => t.lines[0]?.includes("hello"));
  expect({
    prominence: body?.style.prominence,
    bold: body?.style.bold,
  }).toEqual({
    prominence: FgP.primary,
    bold: undefined,
  });
});

test("window chrome keeps annotation on ╭╮ and shortcuts on ╰╯", () => {
  const { ops } = chromeFramePaintOps(
    {
      type: "chrome_frame",
      key: "peek",
      width: 40,
      draft: "",
      bodySegRows: [[{ text: " " }], [{ text: " " }]],
      annotation: "Explore",
      hotkeys: [{ key: "Esc", action: "close" }],
      hotkeysBottom: true,
    },
    { x: 0, y: 0, w: 40, h: 6 },
  );
  const texts = ops.filter((op) => op.kind === "text");
  const rowOf = (match: string) => texts.find((t) => t.lines[0] === match || t.lines[0]?.includes(match))?.rect.y;
  expect({
    title: rowOf("Explore"),
    esc: rowOf("Esc"),
    close: rowOf("close"),
    top: rowOf("╭"),
    bot: rowOf("╰"),
  }).toEqual({
    title: 0,
    esc: 3,
    close: 3,
    top: 0,
    bot: 3,
  });
});

test("joinTop paints ├┤ on the top rule", () => {
  const { ops } = chromeFramePaintOps(
    {
      type: "chrome_frame",
      key: "c",
      width: 20,
      draft: "hi",
      joinTop: true,
      plainBottom: true,
    },
    { x: 0, y: 0, w: 20, h: 4 },
  );
  const top = ops.flatMap((op) => (op.kind === "text" && op.rect.y === 0 ? [op.lines[0] ?? ""] : [])).join("");
  expect({
    left: top.startsWith(CHROME_FRAME_JOIN.left),
    right: top.endsWith(CHROME_FRAME_JOIN.right),
  }).toEqual({ left: true, right: true });
});

test("stacked join keeps annotation on ╭╮ and shortcuts on ├┤", () => {
  const { ops } = chromeFramePaintOps(
    {
      type: "chrome_frame",
      key: "confirm",
      width: 48,
      draft: "",
      bodySegRows: [[{ text: "q  invoices" }]],
      joinBottom: true,
      plainBottom: true,
      hotkeys: [
        { key: "Enter", action: "Allow" },
        { key: "Esc", action: "Deny" },
      ],
      annotation: "Gmail **send email**",
    },
    { x: 0, y: 0, w: 48, h: 8 },
  );
  const texts = ops.filter((op) => op.kind === "text");
  const rowOf = (match: string) => texts.find((t) => t.lines[0] === match || t.lines[0]?.includes(match))?.rect.y;
  expect({
    gmail: rowOf("Gmail"),
    action: rowOf("send email"),
    enter: rowOf("⏎"),
    allow: rowOf("Allow"),
    body: rowOf("q  invoices"),
  }).toEqual({
    gmail: 0,
    action: 0,
    enter: 2,
    allow: 2,
    body: 1,
  });
});

test("stacked join paints joinAnnotation on ├┤, identity on ╭╮", () => {
  const { ops } = chromeFramePaintOps(
    {
      type: "chrome_frame",
      key: "confirm",
      width: 48,
      draft: "",
      bodySegRows: [[{ text: "rm file" }]],
      joinBottom: true,
      plainBottom: true,
      hotkeys: [
        { key: "Enter", action: "Allow" },
        { key: "Esc", action: "Deny" },
      ],
      annotation: "run command",
      joinAnnotation: "Auth refactor",
    },
    { x: 0, y: 0, w: 48, h: 8 },
  );
  const texts = ops.filter((op) => op.kind === "text");
  const rowOf = (match: string) => texts.find((t) => t.lines[0] === match || t.lines[0]?.includes(match))?.rect.y;
  expect({
    identity: rowOf("run command"),
    title: rowOf("Auth refactor"),
    allow: rowOf("Allow"),
    body: rowOf("rm file"),
  }).toEqual({
    identity: 0,
    title: 2,
    allow: 2,
    body: 1,
  });
});

test("Cmd/Ctrl swaps furniture status for live quota", () => {
  const windows = [{ remainingPercent: 67, resetAt: 90 * 60 }];
  const statusItems = ["grok-4", "grok", { text: "auto", role: "auto" }];
  const lineOf = (segs: ChromeSeg[]) => segs.map((s) => s.text).join("");
  const idle = chromeFrameBottomSegs(80, { statusItems, quotaWindows: windows, nowMs: 0 });
  const held = chromeFrameBottomSegs(80, {
    statusItems,
    quotaWindows: windows,
    modHeld: true,
    nowMs: 0,
  });
  const later = chromeFrameBottomSegs(80, {
    statusItems,
    quotaWindows: windows,
    modHeld: true,
    nowMs: 61_000,
  });
  expect({
    idleModel: lineOf(idle).includes("grok-4"),
    idleQuota: lineOf(idle).includes("67%"),
    heldModel: lineOf(held).includes("grok-4"),
    heldQuota: lineOf(held).includes("67% left for 1 hour and 30 minutes"),
    heldAuto: lineOf(held).includes("auto"),
    heldLive: held.some((seg) => seg.live?.kind === "quota"),
    later: lineOf(later).includes("1 hour and 29 minutes"),
  }).toEqual({
    idleModel: true,
    idleQuota: false,
    heldModel: false,
    heldQuota: true,
    heldAuto: true,
    heldLive: true,
    later: true,
  });
});

test("narrow persist-mod rail keeps occupancy when quota does not fit", () => {
  const windows = [{ remainingPercent: 51, resetAt: 5 * 3600 }];
  const statusItems = ["grok-4", { text: "auto", role: "auto" }];
  const lineOf = (segs: ChromeSeg[]) => segs.map((s) => s.text).join("");
  const held = {
    statusItems,
    quotaWindows: windows,
    contextUsed: 10_000,
    contextLimit: 500_000,
    modHeld: true,
    nowMs: 0,
  };
  const wide = chromeFrameBottomSegs(80, held);
  const narrow = chromeFrameBottomSegs(24, held);
  const tighter = chromeFrameBottomSegs(16, held);
  expect({
    wide: lineOf(wide).includes("10k/500k · 51% left for 5 hours"),
    narrow: lineOf(narrow).includes("10k/500k"),
    narrowQuota: lineOf(narrow).includes("51%"),
    narrowLive: narrow.some((seg) => seg.live?.kind === "quota"),
    tighter: lineOf(tighter).includes("10k/500k"),
    signal: lineOf(narrow).includes("auto"),
  }).toEqual({
    wide: true,
    narrow: true,
    narrowQuota: false,
    narrowLive: false,
    tighter: false,
    signal: true,
  });
});

test("persist-mod prefixes quota with compact occupancy", () => {
  const windows = [{ remainingPercent: 51, resetAt: 5 * 3600 }];
  const statusItems = ["grok-4", "grok"];
  const lineOf = (segs: ChromeSeg[]) => segs.map((s) => s.text).join("");
  const held = chromeFrameBottomSegs(80, {
    statusItems,
    quotaWindows: windows,
    contextUsed: 10_000,
    contextLimit: 500_000,
    modHeld: true,
    nowMs: 0,
  });
  const occupancyOnly = chromeFrameBottomSegs(80, {
    statusItems,
    contextUsed: 10_000,
    contextLimit: 500_000,
    modHeld: true,
    nowMs: 0,
  });
  expect({
    both: lineOf(held).includes("10k/500k · 51% left for 5 hours"),
    occupancy: lineOf(occupancyOnly).includes("10k/500k"),
    droppedModel: !lineOf(held).includes("grok-4"),
    livePrefix: held.find((seg) => seg.live?.kind === "quota")?.live,
  }).toEqual({
    both: true,
    occupancy: true,
    droppedModel: true,
    livePrefix: expect.objectContaining({
      kind: "quota",
      prefix: "10k/500k",
    }),
  });
});
