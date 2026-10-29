import { expect, test } from "vitest";

import { createBuffer } from "../../buffer/index.js";
import { layout, paintFrame } from "../index.js";
import { omittedLabel, planSqueeze, squeezeOverlay, type SqueezeSlot } from "../squeeze.js";

function ones(n: number): number[] {
  return Array.from({ length: n }, () => 1);
}

function face(slots: SqueezeSlot[]): string[] {
  return slots.map((s) => (s.kind === "child" ? `#${s.index}` : `omit:${s.count}`));
}

test("planSqueeze overview grows the head; tour keeps both pins", () => {
  const overviewTight = planSqueeze({
    heights: ones(20),
    overlay: { y: 0, h: 9 },
    naturalY: 0,
    clipH: 20,
    head: 4,
    tail: 4,
  });
  const overviewWide = planSqueeze({
    heights: ones(20),
    overlay: { y: 0, h: 15 },
    naturalY: 0,
    clipH: 20,
    head: 4,
    tail: 4,
  });
  const tourTop = planSqueeze({
    heights: ones(100),
    overlay: { y: 0, h: 20 },
    naturalY: 0,
    clipH: 20,
    head: 4,
    tail: 4,
  });
  const tourMid = planSqueeze({
    heights: ones(100),
    overlay: { y: 40, h: 20 },
    naturalY: 0,
    clipH: 20,
    head: 4,
    tail: 4,
  });
  const tourEnd = planSqueeze({
    heights: ones(100),
    overlay: { y: 80, h: 20 },
    naturalY: 0,
    clipH: 20,
    head: 4,
    tail: 4,
  });
  const fits = planSqueeze({
    heights: ones(6),
    overlay: { y: 0, h: 10 },
    naturalY: 0,
    clipH: 10,
    head: 4,
    tail: 4,
  });
  const tiny = planSqueeze({
    heights: ones(20),
    overlay: { y: 0, h: 5 },
    naturalY: 0,
    clipH: 20,
    head: 4,
    tail: 4,
  });

  expect({
    tight: {
      face: face(overviewTight),
      omit: omittedLabel(12),
    },
    wide: face(overviewWide),
    tourTop: face(tourTop),
    tourMid: face(tourMid),
    tourEnd: face(tourEnd),
    fits: face(fits),
    tiny: face(tiny),
  }).toEqual({
    tight: {
      face: ["#0", "#1", "#2", "#3", "omit:12", "#16", "#17", "#18", "#19"],
      omit: "·· 12 lines omitted ··",
    },
    wide: ["#0", "#1", "#2", "#3", "#4", "#5", "#6", "#7", "#8", "#9", "omit:6", "#16", "#17", "#18", "#19"],
    tourTop: [
      "#0",
      "#1",
      "#2",
      "#3",
      "#4",
      "#5",
      "#6",
      "#7",
      "#8",
      "#9",
      "#10",
      "#11",
      "#12",
      "#13",
      "#14",
      "omit:81",
      "#96",
      "#97",
      "#98",
      "#99",
    ],
    tourMid: [
      "#0",
      "#1",
      "#2",
      "#3",
      "omit:40",
      "#44",
      "#45",
      "#46",
      "#47",
      "#48",
      "#49",
      "#50",
      "#51",
      "#52",
      "#53",
      "omit:42",
      "#96",
      "#97",
      "#98",
      "#99",
    ],
    tourEnd: [
      "#0",
      "#1",
      "#2",
      "#3",
      "omit:81",
      "#85",
      "#86",
      "#87",
      "#88",
      "#89",
      "#90",
      "#91",
      "#92",
      "#93",
      "#94",
      "#95",
      "#96",
      "#97",
      "#98",
      "#99",
    ],
    fits: ["#0", "#1", "#2", "#3", "#4", "#5"],
    tiny: ["#0", "#1", "omit:16", "#18", "#19"],
  });
});

function visibleKeys(frame: { byKey: Map<string, { hitRect: { y: number } }> }): string[] {
  return [...frame.byKey.keys()]
    .filter((k) => k.startsWith("l") || k.includes("omit-"))
    .sort((a, b) => {
      const ay = frame.byKey.get(a)!.hitRect.y;
      const by = frame.byKey.get(b)!.hitRect.y;
      return ay - by || a.localeCompare(b);
    });
}

test("viewport squeeze peeks head+omit+tail when the last child is below", () => {
  const lines = Array.from({ length: 20 }, (_, i) => ({
    type: "text" as const,
    content: `L${i.toString().padStart(2, "0")}`,
    key: `l${i}`,
  }));
  const tree = {
    type: "viewport" as const,
    id: "vp",
    overflowAnchor: "none" as const,
    children: [
      {
        type: "box" as const,
        key: "tape",
        children: Array.from({ length: 10 }, (_, i) => ({
          type: "text" as const,
          content: `T${i}`,
          key: `t${i}`,
        })),
      },
      {
        type: "box" as const,
        key: "diff",
        style: { squeeze: { head: 4, tail: 4 } },
        children: lines,
      },
    ],
  };
  const below = layout({ ...tree, scroll: 0 }, { w: 24, h: 10 });
  const filled = layout({ ...tree, scroll: 10 }, { w: 24, h: 10 });

  expect({
    peek: squeezeOverlay({ x: 0, y: 10, w: 24, h: 20 }, { x: 0, y: 0, w: 24, h: 10 }, 20, 9),
    below: {
      keys: visibleKeys(below),
      headY: below.byKey.get("l0")?.hitRect.y,
      tailY: below.byKey.get("l19")?.hitRect.y,
      hidden: below.byKey.has("l4") || below.byKey.has("l15"),
    },
    filled: {
      keys: visibleKeys(filled),
      hidden: filled.byKey.has("l5") || filled.byKey.has("l15"),
    },
  }).toEqual({
    peek: { x: 0, y: 1, w: 24, h: 9 },
    below: {
      keys: ["l0", "l1", "l2", "l3", "diff:omit-mid", "l16", "l17", "l18", "l19"],
      headY: 1,
      tailY: 9,
      hidden: false,
    },
    filled: {
      keys: ["l0", "l1", "l2", "l3", "l4", "diff:omit-below", "l16", "l17", "l18", "l19"],
      hidden: false,
    },
  });
});

test("squeeze overlay floors void cells over scrolled tape", () => {
  const tree = {
    type: "viewport" as const,
    id: "vp",
    overflowAnchor: "none" as const,
    scroll: 0,
    children: [
      {
        type: "box" as const,
        key: "tape",
        children: Array.from({ length: 10 }, (_, i) => ({
          type: "text" as const,
          content: "XXXXXXXXXXXXXXXXXXXXXXXX",
          key: `t${i}`,
          style: { bgRole: "diff_del" },
        })),
      },
      {
        type: "box" as const,
        key: "diff",
        style: { squeeze: { head: 4, tail: 4 } },
        children: Array.from({ length: 20 }, (_, i) => ({
          type: "text" as const,
          content: "PEEK",
          key: `l${i}`,
        })),
      },
    ],
  };
  const frame = layout(tree, { w: 24, h: 10 });
  const buf = createBuffer(24, 10);
  paintFrame(frame, buf);
  const under = buf.cells[1 * 24 + 10]!;
  const peek = buf.cells[1 * 24 + 0]!;
  const above = buf.cells[0 * 24 + 0]!;
  expect({
    tape: above.ch,
    peek: peek.ch,
    voidCh: under.ch,
    voidHasBg: under.style.bgRgb !== undefined || under.style.bg !== undefined || under.style.bgRole !== undefined,
    voidCast: under.style.cast,
    voidIsX: under.ch === "X",
  }).toEqual({
    tape: "X",
    peek: "P",
    voidCh: " ",
    voidHasBg: false,
    voidCast: "transparent",
    voidIsX: false,
  });
});

/**
 * The ask Diff seats below the tape as the viewport's last child, wrapped in
 * intermediate boxes (ask pin → identity + diff exception). Those wrappers
 * used to skip placement when fully below the clip, so the squeeze peek never
 * painted — the pending edit vanished instead of holding the clip floor.
 */
test("nested squeeze still peeks when every wrapper sits below the clip", () => {
  const tree = {
    type: "viewport" as const,
    id: "vp",
    overflowAnchor: "none" as const,
    scroll: 0,
    children: [
      {
        type: "box" as const,
        key: "tape",
        children: Array.from({ length: 10 }, (_, i) => ({
          type: "text" as const,
          content: `T${i}`,
          key: `t${i}`,
        })),
      },
      {
        // ask:diff wrapper box (assemblePaintFrame APP_ASK_DIFF_KEY).
        type: "box" as const,
        key: "ask:diff",
        children: [
          {
            // ask pin: identity + diff exception.
            type: "box" as const,
            key: "ask:body",
            style: { padding: { t: 1 } },
            children: [
              { type: "text" as const, content: "? edit_file a.ts", key: "ask:id" },
              {
                type: "indentation_exception" as const,
                kind: "diff" as const,
                key: "ask:diff-body",
                children: [
                  {
                    type: "box" as const,
                    key: "ask:squeeze",
                    style: { squeeze: { head: 4, tail: 4 } },
                    children: Array.from({ length: 20 }, (_, i) => ({
                      type: "text" as const,
                      content: `L${i.toString().padStart(2, "0")}`,
                      key: `l${i}`,
                    })),
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
  const frame = layout(tree, { w: 24, h: 10 });
  expect(visibleKeys(frame)).toEqual(["l0", "l1", "l2", "l3", "ask:squeeze:omit-mid", "l16", "l17", "l18", "l19"]);
  expect(frame.byKey.get("l19")?.hitRect.y).toBe(9);
  expect(frame.byKey.get("l0")?.hitRect.y).toBe(1);
});
