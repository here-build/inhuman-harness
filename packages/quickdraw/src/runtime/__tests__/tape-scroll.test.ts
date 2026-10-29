import { expect, test } from "vitest";

import { layout, type LayoutNode } from "../../layout/index.js";
import { APP_AGENTS_PREVIEW_KEY, APP_AGENTS_PREVIEW_OVERLAY_KEY } from "../agents_preview.js";
import {
  APP_TAPE_KEY,
  assemblePaintFrame,
  createPaintLocal,
  pickerHostFromLayout,
  tapeViewportMetrics,
  type PreparedPaint,
  type RetainedPaintSource,
} from "../paint_source.js";
import { Renderer } from "../renderer.js";
import { FakeBoxCadencePort, FakeTtyInput, FakeTtyOutput } from "./_helpers.js";

const GEOMETRY = { cols: 40, rows: 16 };
const syncSchedule = (fn: () => void): void => fn();

function sgr(button: number, col: number, row: number, release = false): string {
  return `\x1b[<${button};${col};${row}${release ? "m" : "M"}`;
}

function agentsSessionPanel(): LayoutNode {
  return {
    type: "box",
    key: "agents:body",
    style: { width: 18 },
    children: [
      {
        type: "box",
        key: "session:s-auth",
        intent: "activate",
        userSelect: "none",
        style: { width: 16, height: 1 },
        children: [{ type: "text", key: "session:s-auth:name", content: "Auth refactor", whiteSpace: "nowrap" }],
      },
      {
        type: "box",
        key: "call:call-explore",
        intent: "activate",
        userSelect: "none",
        style: { width: 16, height: 1 },
        children: [{ type: "text", key: "call:call-explore:name", content: "Explore", whiteSpace: "nowrap" }],
      },
      {
        type: "box",
        key: "bot:reviewer",
        style: { width: 16, height: 1 },
        children: [{ type: "text", key: "bot:reviewer:name", content: "Reviewer", whiteSpace: "nowrap" }],
      },
    ],
  };
}

function tapeBox(n: number): LayoutNode {
  return {
    type: "box",
    key: APP_TAPE_KEY,
    children: Array.from({ length: n }, (_, i) => ({
      type: "text" as const,
      key: `l${i}`,
      content: `line-${i}`,
      whiteSpace: "nowrap",
    })),
  };
}

function pickerComposer(n: number): LayoutNode {
  const viewport = 4;
  const rows = Array.from({ length: n }, (_, i) => ({
    key: `choice:${i}`,
    name: `row${i}`,
  }));
  return {
    type: "chrome_frame",
    key: "slash-complete",
    width: GEOMETRY.cols,
    draft: "",
    bodyUserSelect: "none",
    bodySegRows: rows.slice(0, viewport).map((row) => [{ text: row.name, role: "muted" }]),
    picker: {
      rows,
      selectedKey: rows[0]!.key,
      scrollOffset: 0,
      viewport,
    },
    joinBottom: true,
    plainBottom: true,
  };
}

function productSource(
  local: ReturnType<typeof createPaintLocal>,
  state: {
    n: number;
    picker: boolean;
    agents?: boolean;
    preview?: boolean;
    previewTape?: LayoutNode;
    toggles?: string[];
  },
): RetainedPaintSource {
  const prepare = (): PreparedPaint => {
    const composer = state.picker
      ? pickerComposer(12)
      : { type: "chrome_frame" as const, key: "composer:frame", width: GEOMETRY.cols, draft: "" };
    const root = assemblePaintFrame({
      tape: tapeBox(state.n),
      composer,
      cols: local.cols,
      rows: local.rows,
      scroll: local.tapeScroll,
      atBottom: local.tapeAtBottom,
      agents: state.agents ? agentsSessionPanel() : null,
      agentsPeek: state.agents
        ? {
            type: "box" as const,
            key: "agents:peek",
            userSelect: "none" as const,
            style: { width: 8, height: 3 },
            children: [{ type: "text" as const, content: "sonnet" }],
          }
        : null,
      agentsFocusKey: state.agents ? "session:s-auth" : undefined,
      agentsPreview: state.previewTape
        ? state.previewTape
        : state.preview
          ? {
              type: "box" as const,
              key: "preview:tape",
              children: Array.from({ length: 40 }, (_, i) => ({
                type: "text" as const,
                key: `peek-${i}`,
                content: `peek-${i}`,
                whiteSpace: "nowrap" as const,
              })),
            }
          : null,
      agentsPreviewTitle: state.preview ? "Explore" : undefined,
      agentsPreviewScroll: local.previewScroll,
      agentsPreviewAtBottom: local.previewAtBottom,
    });
    return {
      root,
      composer: { draft: "", cursor: 0, mark: null, interactive: true },
      birthSites: [],
      progressSites: [],
      picker: pickerHostFromLayout(root),
    };
  };
  return {
    bind() {
      return { [Symbol.dispose]() {} };
    },
    prepare,
    toggleCollapsed(blockId) {
      state.toggles?.push(blockId);
    },
  };
}

function makeHost(local: ReturnType<typeof createPaintLocal>, source: RetainedPaintSource) {
  const port = new FakeBoxCadencePort();
  const input = new FakeTtyInput();
  const output = new FakeTtyOutput(GEOMETRY.cols, GEOMETRY.rows);
  const host = new Renderer({
    port,
    input,
    output,
    schedule: syncSchedule,
    paintSource: source,
    paintLocal: local,
    now: () => 0,
  });
  return { host, port, input, output };
}

function stampOf(source: RetainedPaintSource, local: ReturnType<typeof createPaintLocal>) {
  const root = source.prepare().root;
  if (root === null) throw new Error("no root");
  const frame = layout(root, { w: local.cols, h: local.rows });
  const vp = tapeViewportMetrics(frame.byKey);
  if (vp === null) throw new Error("no tape viewport");
  return vp;
}

function sgrCell(rect: { x: number; y: number; w: number; h: number }): { col: number; row: number } {
  return { col: rect.x + 1, row: rect.y + 1 };
}

test("transcript follow-tail freezes on an upward move", () => {
  const local = createPaintLocal(GEOMETRY.cols, GEOMETRY.rows);
  const state = { n: 24, picker: false };
  const source = productSource(local, state);
  const { host, input, port } = makeHost(local, source);
  host.start();

  const s0 = stampOf(source, local);
  expect({
    atBottom: local.tapeAtBottom,
    scrollY: s0.scrollY,
    max: s0.maxScroll > 3,
  }).toEqual({ atBottom: true, scrollY: s0.maxScroll, max: true });

  const cell = sgrCell(s0.hitRect);
  input.type(sgr(64, cell.col, cell.row));
  const s1 = stampOf(source, local);
  expect({
    atBottom: local.tapeAtBottom,
    scrollY: s1.scrollY,
    posted: port.posted.filter((m) => m.kind === "picker_scroll"),
  }).toEqual({
    atBottom: false,
    scrollY: s0.maxScroll - 1,
    posted: [],
  });

  state.n += 10;
  host.requestPaint();
  const s2 = stampOf(source, local);
  expect({ atBottom: local.tapeAtBottom, scrollY: s2.scrollY, grew: s2.maxScroll > s1.maxScroll }).toEqual({
    atBottom: false,
    scrollY: s1.scrollY,
    grew: true,
  });

  for (let i = 0; i < 8 && !local.tapeAtBottom; i++) input.type("\x1b[6~");
  expect(local.tapeAtBottom).toBe(true);

  state.n += 10;
  host.requestPaint();
  const s3 = stampOf(source, local);
  expect({ atBottom: local.tapeAtBottom, scrollY: s3.scrollY }).toEqual({
    atBottom: true,
    scrollY: s3.maxScroll,
  });

  host.stop();
});

test("Ctrl-O toggles tape density on the host and does not post to the worker", () => {
  const local = createPaintLocal(GEOMETRY.cols, GEOMETRY.rows);
  const source = productSource(local, { n: 8, picker: false });
  const { host, input, port } = makeHost(local, source);
  host.start();
  expect(local.tapeExpanded).toBe(false);
  input.type("\x0f");
  expect(local.tapeExpanded).toBe(true);
  input.type("\x0f");
  expect({
    expanded: local.tapeExpanded,
    posted: port.posted.filter((m) => m.kind === "input_events" || m.kind === "picker_scroll"),
  }).toEqual({
    expanded: false,
    posted: [],
  });
  host.stop();
});

test("wheel over picker does not scroll the tape", () => {
  const local = createPaintLocal(GEOMETRY.cols, GEOMETRY.rows);
  const state = { n: 24, picker: true };
  const source = productSource(local, state);
  const { host, input, port } = makeHost(local, source);
  host.start();

  const before = { scroll: local.tapeScroll, atBottom: local.tapeAtBottom };
  const root = source.prepare().root;
  if (root === null) throw new Error("no root");
  const frame = layout(root, { w: local.cols, h: local.rows });
  const chrome = frame.byKey.get("slash-complete:chrome");
  if (chrome === undefined) throw new Error("no picker chrome");
  const cell = sgrCell(chrome.hitRect);
  input.type(sgr(65, cell.col, cell.row));

  expect({
    tape: { scroll: local.tapeScroll, atBottom: local.tapeAtBottom },
    picker: port.posted.filter((m) => m.kind === "picker_scroll"),
  }).toEqual({
    tape: before,
    picker: [{ kind: "picker_scroll", delta: 1 }],
  });

  host.stop();
});

test("wheel while agents drawer is open does not scroll the tape", () => {
  const local = createPaintLocal(GEOMETRY.cols, GEOMETRY.rows);
  const state = { n: 24, picker: false, agents: true };
  const source = productSource(local, state);
  const { host, input, port } = makeHost(local, source);
  host.start();

  const before = { scroll: local.tapeScroll, atBottom: local.tapeAtBottom };
  const root = source.prepare().root;
  if (root === null) throw new Error("no root");
  const frame = layout(root, { w: local.cols, h: local.rows });
  const tape = tapeViewportMetrics(frame.byKey);
  if (tape === null) throw new Error("no tape");
  const cell = sgrCell(tape.hitRect);
  input.type(sgr(65, cell.col, cell.row));

  expect({
    tape: { scroll: local.tapeScroll, atBottom: local.tapeAtBottom },
    agents: port.posted.filter((m) => m.kind === "agents_scroll" || m.kind === "picker_scroll"),
  }).toEqual({
    tape: before,
    agents: [{ kind: "agents_scroll", delta: 1 }],
  });

  host.stop();
});

test("agents drawer hover focuses a session row and click activates it", () => {
  const local = createPaintLocal(GEOMETRY.cols, GEOMETRY.rows);
  const source = productSource(local, { n: 8, picker: false, agents: true });
  const { host, input, port, output } = makeHost(local, source);
  host.start();

  const root = source.prepare().root;
  if (root === null) throw new Error("no root");
  const frame = layout(root, { w: local.cols, h: local.rows });
  const row = frame.byKey.get("session:s-auth");
  if (row === undefined) throw new Error("no session row");
  const cell = sgrCell(row.hitRect);

  input.type(sgr(35, cell.col, cell.row));
  input.type(sgr(0, cell.col, cell.row, false));
  input.type(sgr(0, cell.col, cell.row, true));

  const bot = frame.byKey.get("bot:reviewer");
  if (bot === undefined) throw new Error("no bot row");
  const afterSession = output.writes.join("");
  input.type(sgr(35, sgrCell(bot.hitRect).col, sgrCell(bot.hitRect).row));
  const afterBot = output.writes.join("");
  input.type(sgr(35, GEOMETRY.cols, 2));

  expect({
    motion: afterSession.includes("\x1b[?1003h"),
    pointer: afterSession.includes("\x1b]22;pointer\x07"),
    offBot: afterBot.includes("\x1b]22;default\x07"),
    posted: port.posted.filter((m) => m.kind === "agents_hover" || m.kind === "activate"),
  }).toEqual({
    motion: true,
    pointer: true,
    offBot: true,
    posted: [
      { kind: "agents_hover", key: "session:s-auth" },
      { kind: "activate", key: "session:s-auth" },
      { kind: "agents_hover", key: null },
    ],
  });

  host.stop();
});

test("agents drawer click on a subagent activates the call row", () => {
  const local = createPaintLocal(GEOMETRY.cols, GEOMETRY.rows);
  const source = productSource(local, { n: 8, picker: false, agents: true });
  const { host, input, port } = makeHost(local, source);
  host.start();

  const root = source.prepare().root;
  if (root === null) throw new Error("no root");
  const frame = layout(root, { w: local.cols, h: local.rows });
  const row = frame.byKey.get("call:call-explore");
  if (row === undefined) throw new Error("no call row");
  const cell = sgrCell(row.hitRect);

  input.type(sgr(35, cell.col, cell.row));
  input.type(sgr(0, cell.col, cell.row, false));
  input.type(sgr(0, cell.col, cell.row, true));

  expect(port.posted.filter((m) => m.kind === "agents_hover" || m.kind === "activate")).toEqual([
    { kind: "agents_hover", key: "call:call-explore" },
    { kind: "activate", key: "call:call-explore" },
  ]);

  host.stop();
});

test("sneak-peek overlay eats mouse; drawer clicks stay inert", () => {
  const local = createPaintLocal(GEOMETRY.cols, GEOMETRY.rows);
  const source = productSource(local, { n: 8, picker: false, agents: true, preview: true });
  const { host, input, port } = makeHost(local, source);
  host.start();

  const root = source.prepare().root;
  if (root === null) throw new Error("no root");
  const frame = layout(root, { w: local.cols, h: local.rows });
  const row = frame.byKey.get("call:call-explore");
  if (row === undefined) throw new Error("no call row");
  const cell = sgrCell(row.hitRect);

  input.type(sgr(35, cell.col, cell.row));
  input.type(sgr(0, cell.col, cell.row, false));
  input.type(sgr(0, cell.col, cell.row, true));

  expect(port.posted.filter((m) => m.kind === "agents_hover" || m.kind === "activate")).toEqual([]);

  host.stop();
});

test("click outside sneak-peek posts backdrop activate; inside does not", () => {
  const local = createPaintLocal(GEOMETRY.cols, GEOMETRY.rows);
  const source = productSource(local, { n: 8, picker: false, agents: true, preview: true });
  const { host, input, port } = makeHost(local, source);
  host.start();

  const root = source.prepare().root;
  if (root === null) throw new Error("no root");
  const frame = layout(root, { w: local.cols, h: local.rows });
  const modal = frame.byKey.get(APP_AGENTS_PREVIEW_KEY);
  if (modal === undefined) throw new Error("no preview");
  const inside = sgrCell(modal.hitRect);

  input.type(sgr(0, inside.col, inside.row, false));
  input.type(sgr(0, inside.col, inside.row, true));
  const afterInside = port.posted.filter((m) => m.kind === "activate");

  input.type(sgr(0, 1, 1, false));
  input.type(sgr(0, 1, 1, true));

  expect({
    afterInside,
    outside: port.posted.filter((m) => m.kind === "activate"),
  }).toEqual({
    afterInside: [],
    outside: [{ kind: "activate", key: `${APP_AGENTS_PREVIEW_OVERLAY_KEY}:backdrop` }],
  });

  host.stop();
});

test("wheel over sneak-peek scrolls the peeked tape, not the host tape", () => {
  const local = createPaintLocal(GEOMETRY.cols, GEOMETRY.rows);
  const source = productSource(local, { n: 24, picker: false, agents: true, preview: true });
  const { host, input, port } = makeHost(local, source);
  host.start();

  const before = {
    tape: { scroll: local.tapeScroll, atBottom: local.tapeAtBottom },
    preview: { scroll: local.previewScroll, atBottom: local.previewAtBottom },
  };
  const root = source.prepare().root;
  if (root === null) throw new Error("no root");
  const frame = layout(root, { w: local.cols, h: local.rows });
  const modal = frame.byKey.get(APP_AGENTS_PREVIEW_KEY);
  if (modal === undefined) throw new Error("no preview");
  const cell = sgrCell(modal.hitRect);
  input.type(sgr(64, cell.col, cell.row));

  expect({
    tape: { scroll: local.tapeScroll, atBottom: local.tapeAtBottom },
    previewAtBottom: local.previewAtBottom,
    previewScroll: local.previewScroll < before.preview.scroll,
    posted: port.posted.filter((m) => m.kind === "agents_scroll" || m.kind === "picker_scroll"),
  }).toEqual({
    tape: before.tape,
    previewAtBottom: false,
    previewScroll: true,
    posted: [],
  });

  host.stop();
});

test("click on sneak-peek disclosure toggles collapse; drawer stays inert", () => {
  const local = createPaintLocal(GEOMETRY.cols, GEOMETRY.rows);
  const toggles: string[] = [];
  const source = productSource(local, {
    n: 8,
    picker: false,
    agents: true,
    preview: true,
    toggles,
    previewTape: {
      type: "disclosure",
      key: "peek:thought",
      collapsed: true,
      intent: "activate",
      onClick: { type: "toggle_collapsed", blockId: "peek:thought" },
      userSelect: "none",
      summary: { type: "text", key: "peek:thought:sum", content: "thought" },
      children: [{ type: "text", key: "peek:thought:body", content: "secret reasoning" }],
    },
  });
  const { host, input, port } = makeHost(local, source);
  host.start();

  const root = source.prepare().root;
  if (root === null) throw new Error("no root");
  const frame = layout(root, { w: local.cols, h: local.rows });
  const hit = frame.byKey.get("peek:thought");
  if (hit === undefined) throw new Error("no peek disclosure");
  const cell = sgrCell(hit.hitRect);

  input.type(sgr(0, cell.col, cell.row, false));
  input.type(sgr(0, cell.col, cell.row, true));

  expect({
    toggles,
    posted: port.posted.filter((m) => m.kind === "agents_hover" || m.kind === "activate"),
  }).toEqual({
    toggles: ["peek:thought"],
    posted: [],
  });

  host.stop();
});
