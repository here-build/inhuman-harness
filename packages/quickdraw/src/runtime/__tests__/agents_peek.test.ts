import { expect, test } from "vitest";

import { layout } from "../../layout/index.js";
import {
  AGENTS_PEEK_GAP,
  AGENTS_PEEK_RIGHT_MARGIN,
  APP_AGENTS_PEEK_KEY,
  APP_AGENTS_PEEK_OVERLAY_KEY,
  placeAgentsPeek,
  withAgentsPeek,
} from "../agents_peek.js";
import { assemblePaintFrame, mailboxComposerSite, mailboxTapeSite } from "../paint_source.js";

test("placeAgentsPeek sits 1 cell off the panel, flips up, then clamps", () => {
  const panel = { x: 1, y: 1, w: 16, h: 12 };
  const down = placeAgentsPeek({
    anchor: { x: 2, y: 3, w: 14, h: 1 },
    panel,
    cols: 40,
    rows: 12,
    size: { w: 10, h: 4 },
  });
  const flip = placeAgentsPeek({
    anchor: { x: 2, y: 10, w: 14, h: 1 },
    panel,
    cols: 40,
    rows: 12,
    size: { w: 10, h: 4 },
  });
  const clamp = placeAgentsPeek({
    anchor: { x: 2, y: 5, w: 14, h: 1 },
    panel,
    cols: 40,
    rows: 8,
    size: { w: 10, h: 8 },
  });
  const tight = placeAgentsPeek({
    anchor: { x: 2, y: 3, w: 14, h: 1 },
    panel,
    cols: 20,
    rows: 12,
    size: { w: 10, h: 3 },
  });
  const noRoom = placeAgentsPeek({
    anchor: { x: 2, y: 3, w: 14, h: 1 },
    panel: { x: 0, y: 0, w: 40, h: 12 },
    cols: 40,
    rows: 12,
    size: { w: 8, h: 3 },
  });
  const flush = placeAgentsPeek({
    anchor: { x: 2, y: 3, w: 14, h: 1 },
    panel,
    cols: 19,
    rows: 12,
    size: { w: 10, h: 3 },
  });
  const leftClamp = placeAgentsPeek({
    anchor: { x: 0, y: 0, w: 4, h: 1 },
    panel: { x: 0, y: 0, w: 0, h: 12 },
    cols: 40,
    rows: 12,
    size: { w: 6, h: 2 },
  });

  expect({
    down,
    flip,
    clamp,
    tight,
    noRoom,
    flush,
    leftClamp: leftClamp === null ? null : { x: leftClamp.x, gap: leftClamp.x - 0 },
  }).toEqual({
    down: { x: 18, y: 3, w: 10, h: 4, side: "down" },
    flip: { x: 18, y: 7, w: 10, h: 4, side: "up" },
    clamp: { x: 18, y: 0, w: 10, h: 8, side: "down" },
    tight: { x: 18, y: 3, w: 1, h: 3, side: "down" },
    noRoom: null,
    flush: null,
    leftClamp: { x: 1, gap: 1 },
  });
});

test("withAgentsPeek seats the plaque on the focused row", () => {
  const cols = 40;
  const rows = 12;
  const body = {
    type: "box" as const,
    key: "agents:body",
    children: [
      {
        type: "box" as const,
        key: "call:x",
        style: { height: 1 },
        children: [{ type: "text" as const, content: "Explore" }],
      },
    ],
  };
  const peek = {
    type: "box" as const,
    key: APP_AGENTS_PEEK_KEY,
    style: { width: 12, height: 5 },
    children: [{ type: "text" as const, content: "dive" }],
  };
  const tree = assemblePaintFrame({
    tape: mailboxTapeSite(),
    composer: mailboxComposerSite(),
    cols,
    rows,
    agents: body,
    agentsPeek: peek,
    agentsFocusKey: "call:x",
  });
  const frame = layout(tree, { w: cols, h: rows });
  const panel = frame.byKey.get("agents:panel")!;
  const plaque = frame.byKey.get(APP_AGENTS_PEEK_KEY)!;
  const anchor = frame.byKey.get("call:x")!;
  expect({
    gap: plaque.hitRect.x - (panel.hitRect.x + panel.hitRect.w),
    y: plaque.hitRect.y,
    anchorY: anchor.hitRect.y,
    bottom: plaque.hitRect.y + plaque.hitRect.h <= rows,
    rightMargin: cols - (plaque.hitRect.x + plaque.hitRect.w) >= AGENTS_PEEK_RIGHT_MARGIN,
    overlay:
      tree.type === "box" ? tree.children?.some((child) => child.key === APP_AGENTS_PEEK_OVERLAY_KEY) : undefined,
    gapConst: AGENTS_PEEK_GAP,
    rightConst: AGENTS_PEEK_RIGHT_MARGIN,
  }).toEqual({
    gap: 1,
    y: anchor.hitRect.y,
    anchorY: anchor.hitRect.y,
    bottom: true,
    rightMargin: true,
    overlay: true,
    gapConst: 1,
    rightConst: 1,
  });
});

test("withAgentsPeek is a no-op when the focused row is missing", () => {
  const root = assemblePaintFrame({
    tape: mailboxTapeSite(),
    composer: mailboxComposerSite(),
    cols: 40,
    rows: 12,
    agents: { type: "text", key: "agents:body", content: "Explore" },
  });
  const next = withAgentsPeek({
    root,
    peek: { type: "box", key: APP_AGENTS_PEEK_KEY, children: [] },
    focusKey: "call:missing",
    cols: 40,
    rows: 12,
  });
  expect(next).toBe(root);
});
