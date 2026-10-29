import { expect, test, vi } from "vitest";

import { OSC11_QUERY, THEME_REPORT_DISABLE, THEME_REPORT_ENABLE } from "../../capabilities/sequences.js";
import { attuneTheme, spinnerLive, type LayoutNode, type ThemeBinding } from "../../layout/index.js";
import type { BoxBusDownMessage } from "../box_bus.js";
import { emptyEcho } from "../echo.js";
import { renderFrame } from "../frame.js";
import { paintSnapshotFromMailbox } from "../paint_snapshot.js";
import { createPaintLocal, type PreparedPaint, type RetainedPaintSource } from "../paint_source.js";
import { Renderer, ESC_QUIET_MS, type PresentLoop } from "../renderer.js";
import {
  BLOCK_BOX,
  COMPOSER_BOX,
  SECOND_BLOCK_BOX,
  bufferRows,
  composer,
  FakeBoxCadencePort,
  FakeTtyInput,
  FakeTtyOutput,
  structure,
  text,
} from "./_helpers.js";

const GEOMETRY = { cols: 40, rows: 8 };
const syncSchedule = (fn: () => void): void => fn();

class CountingLoopFactory {
  started: number[] = [];
  loops: Array<{ hz: number; stopped: boolean; fire: () => void }> = [];

  factory = (opts: { targetFps: number; onFrame: (dtMs: number) => void }): PresentLoop => {
    this.started.push(opts.targetFps);
    const loop = {
      hz: opts.targetFps,
      stopped: false,
      fire: () => opts.onFrame(1000 / opts.targetFps),
    };
    this.loops.push(loop);
    return {
      stop: () => {
        loop.stopped = true;
      },
    };
  };

  get active(): Array<{ hz: number; stopped: boolean; fire: () => void }> {
    return this.loops.filter((l) => !l.stopped);
  }
}

function makeHost(
  overrides: {
    loop?: CountingLoopFactory;
    paintSource?: RetainedPaintSource;
    paintLocal?: ReturnType<typeof createPaintLocal>;
    onReady?: () => void;
    onQuit?: () => void;
    quitAction?: () => string;
    targetFps?: number;
    flourishHz?: number;
    sync2026?: boolean;
    now?: () => number;
    onPresent?: (info: { dirtyRows: number; bytes: number; reusedFrame: boolean }) => void;
    theme?: ThemeBinding;
  } = {},
) {
  const port = new FakeBoxCadencePort();
  const input = new FakeTtyInput();
  const output = new FakeTtyOutput();
  const loops = overrides.loop ?? new CountingLoopFactory();
  const host = new Renderer({
    port,
    input,
    output,
    schedule: syncSchedule,
    startLoop: loops.factory,
    paintSource: overrides.paintSource,
    paintLocal: overrides.paintLocal,
    onReady: overrides.onReady,
    onQuit: overrides.onQuit,
    quitAction: overrides.quitAction,
    targetFps: overrides.targetFps,
    flourishHz: overrides.flourishHz,
    sync2026: overrides.sync2026,
    now: overrides.now,
    onPresent: overrides.onPresent,
    theme: overrides.theme,
  });
  return { host, port, input, output, loops };
}

function stubSource(prepared: PreparedPaint): RetainedPaintSource {
  return {
    bind() {
      return { [Symbol.dispose]() {} };
    },
    prepare() {
      return prepared;
    },
  };
}

function paintRows(host: Renderer): string[] {
  return bufferRows(
    renderFrame({
      snapshot: paintSnapshotFromMailbox(host.mailbox),
      geometry: GEOMETRY,
      state: { nowMs: 0, echo: emptyEcho() },
    }).buffer,
  );
}

function stripSgr(ansi: string): string {
  return ansi
    .replaceAll(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replaceAll(/\x1b\[[0-9;:?]*[ -/]*[@-~]/g, "")
    .replaceAll(/\x1b./g, "");
}

function spinnerStructure(gen: number): BoxBusDownMessage {
  return {
    kind: "structure",
    gen,
    tree: {
      root: {
        type: "flex",
        key: "root",
        style: { direction: "column" },
        children: [
          {
            type: "text",
            key: "live",
            content: "",
            live: spinnerLive("thinking"),
          } as unknown as LayoutNode,
          { type: "box", key: "composer", children: [] } as LayoutNode,
        ],
      },
      boxes: { composer: COMPOSER_BOX },
    },
  };
}

test("cadence + mailbox + mirrors", () => {
  {
    const { host, port, output, loops } = makeHost();
    host.start();
    expect({
      firstPaint: output.writes.length > 0,
      live: loops.active.length,
      started: loops.started,
    }).toEqual({ firstPaint: true, live: 0, started: [] });
    port.emit([structure(1, [])]);
    const afterStructure = output.writes.length;
    expect({ live: loops.active.length, writes: output.writes.length }).toEqual({
      live: 0,
      writes: afterStructure,
    });
    host.stop();
  }

  {
    const { host, port, output } = makeHost();
    host.start();
    const before = output.writes.length;
    port.emit([
      structure(1, []),
      { kind: "box_set", boxId: COMPOSER_BOX, value: composer("") },
      { kind: "box_set", boxId: COMPOSER_BOX, value: composer("") },
    ]);
    expect(output.writes.length - before).toEqual(1);
    host.stop();
  }

  {
    const { host, port, input, output } = makeHost();
    host.start();
    port.emit([structure(1, []), { kind: "box_set", boxId: COMPOSER_BOX, value: composer("") }]);
    const before = output.writes.length;
    input.type("h");
    const plain = stripSgr(output.writes.slice(before).join(""));
    expect({ painted: output.writes.length > before, echoed: plain.includes("h") }).toEqual({
      painted: true,
      echoed: true,
    });
    host.stop();
  }

  {
    const { host, port, loops } = makeHost();
    host.start();
    port.emit([
      structure(1, [{ key: "transcript", boxId: BLOCK_BOX }]),
      {
        kind: "box_set",
        boxId: BLOCK_BOX,
        value: {
          type: "indication",
          key: "t",
          gutter: { kind: "spinner", profile: "thinking" },
          children: [{ type: "text", content: "thinking", key: "b" }],
        },
      },
      { kind: "box_set", boxId: COMPOSER_BOX, value: composer("") },
    ]);
    expect({ armed: loops.active.length, hz: loops.active[0]!.hz > 0 }).toEqual({
      armed: 1,
      hz: true,
    });
    host.stop();
  }

  {
    const { host, port, loops } = makeHost();
    host.start();
    port.emit([spinnerStructure(1)]);
    expect({
      armed: loops.active.length,
      hzOk: loops.active[0]!.hz > 0 && loops.active[0]!.hz <= 60,
    }).toEqual({ armed: 1, hzOk: true });
    const hz = loops.active[0]!.hz;
    loops.active[0]!.fire();
    expect(loops.active.map((l) => l.hz)).toEqual([hz]);
    port.emit([structure(2, [])]);
    expect(loops.active.length).toEqual(0);
    host.stop();
  }

  {
    const { host, port, output } = makeHost();
    host.start();
    expect(port.posted).toEqual([{ kind: "resize", cols: output.cols, rows: output.rows }]);
    host.stop();
  }

  {
    const { host, port, output } = makeHost();
    host.start();
    port.emit([structure(1, [])]);
    const before = output.writes.length;
    output.resize(50, 14);
    expect(output.writes.length > before).toEqual(true);
    host.stop();
  }

  {
    const { host, port, input, output } = makeHost();
    host.start();
    port.emit([structure(1, []), { kind: "box_set", boxId: COMPOSER_BOX, value: composer("hi") }]);
    const beforeOut = output.writes.length;
    input.type("\x1b[O");
    const afterOut = output.writes.length;
    input.type("\x1b[I");
    expect({
      focusOut: afterOut > beforeOut,
      focusIn: output.writes.length > afterOut,
    }).toEqual({ focusOut: true, focusIn: true });
    const beforeQuit = output.writes.length;
    input.type("\x03");
    expect(output.writes.length > beforeQuit).toEqual(true);
    host.stop();
  }

  {
    vi.useFakeTimers();
    const { host, port, loops } = makeHost();
    try {
      host.start();
      port.emit([structure(1, [])]);
      const posted = port.posted.length;
      host.onBytes("\x1b");
      expect(loops.active.length).toEqual(0);
      vi.advanceTimersByTime(ESC_QUIET_MS + 5);
      const escEvents = port.posted.slice(posted).flatMap((m) => (m.kind === "input_events" ? m.events : []));
      expect(escEvents.some((e) => e.key === "Escape")).toEqual(true);
      host.stop();
    } finally {
      vi.useRealTimers();
    }
  }

  {
    const { host, port, loops } = makeHost();
    host.start();
    port.emit([spinnerStructure(1)]);
    expect(loops.active.length).toEqual(1);
    host.stop();
    expect(loops.active.length).toEqual(0);
  }

  {
    const { host, port } = makeHost();
    host.start();
    port.emit([
      { kind: "box_set", boxId: 1, value: "a" },
      { kind: "box_set", boxId: 1, value: "b" },
      { kind: "box_set", boxId: 1, value: "c" },
    ]);
    expect({ value: host.mailbox.boxes.get(1), size: host.mailbox.boxes.size }).toEqual({
      value: "c",
      size: 1,
    });
    port.emit([
      { kind: "box_set", boxId: 1, value: "a" },
      { kind: "box_set", boxId: 2, value: "x" },
      { kind: "box_set", boxId: 1, value: "b" },
    ]);
    expect({ one: host.mailbox.boxes.get(1), two: host.mailbox.boxes.get(2) }).toEqual({
      one: "b",
      two: "x",
    });
    port.emit([
      { kind: "structure", gen: 3, tree: { v: 3 } },
      { kind: "structure", gen: 2, tree: { v: 2 } },
      { kind: "structure", gen: 5, tree: { v: 5 } },
      { kind: "structure", gen: 4, tree: { v: 4 } },
    ]);
    expect({ gen: host.mailbox.structureGen, tree: host.mailbox.tree }).toEqual({
      gen: 5,
      tree: { v: 5 },
    });
    port.emit([{ kind: "structure", gen: 5, tree: { v: "duplicate-should-drop" } }]);
    expect(host.mailbox.tree).toEqual({ v: 5 });
    host.stop();
  }

  {
    const { host, port } = makeHost();
    host.start();
    port.emit([
      { kind: "box_set", boxId: 1, value: "a" },
      { kind: "box_set", boxId: 2, value: "b" },
      { kind: "box_set", boxId: 3, value: "c" },
    ]);
    port.emit([{ kind: "box_free", boxIds: [1, 3] }]);
    expect({
      has1: host.mailbox.boxes.has(1),
      has3: host.mailbox.boxes.has(3),
      two: host.mailbox.boxes.get(2),
      size: host.mailbox.boxes.size,
    }).toEqual({ has1: false, has3: false, two: "b", size: 1 });
    const beforeEmpty = host.mailbox;
    port.emit([{ kind: "box_free", boxIds: [] }]);
    expect(host.mailbox).toEqual(beforeEmpty);
    port.emit([{ kind: "box_free", boxIds: [999] }]);
    expect({ size: host.mailbox.boxes.size, two: host.mailbox.boxes.get(2) }).toEqual({
      size: 1,
      two: "b",
    });
    host.stop();
  }

  {
    const { host, port } = makeHost();
    host.start();
    port.emit([
      { kind: "structure", gen: 1, tree: { nodes: [1, 2] } },
      { kind: "box_set", boxId: 1, value: "loading" },
      { kind: "box_set", boxId: 1, value: "ready" },
      { kind: "box_set", boxId: 2, value: "static" },
      { kind: "box_free", boxIds: [1] },
    ]);
    expect({
      gen: host.mailbox.structureGen,
      has1: host.mailbox.boxes.has(1),
      two: host.mailbox.boxes.get(2),
    }).toEqual({ gen: 1, has1: false, two: "static" });
    host.stop();
  }

  {
    const { host, port } = makeHost();
    host.start();
    const blank = renderFrame({
      snapshot: paintSnapshotFromMailbox(host.mailbox),
      geometry: GEOMETRY,
      state: { nowMs: 0, echo: emptyEcho() },
    });
    expect({ frame: blank.frame, rows: bufferRows(blank.buffer).join("") }).toEqual({
      frame: null,
      rows: "",
    });
    port.emit([
      { kind: "box_set", boxId: BLOCK_BOX, value: text("hello world", "b1:body") },
      { kind: "box_set", boxId: COMPOSER_BOX, value: composer("") },
      structure(1, [{ key: "block:m1", boxId: BLOCK_BOX }]),
    ]);
    expect(paintRows(host)[0]).toEqual("hello world");
    const first = paintRows(host);
    port.emit([{ kind: "box_set", boxId: BLOCK_BOX, value: text("draft two", "b1:body") }]);
    const second = paintRows(host);
    expect({ head: second[0], rest: second.slice(1) }).toEqual({
      head: "draft two",
      rest: first.slice(1),
    });
    host.stop();
  }

  {
    const { host, port } = makeHost();
    host.start();
    port.emit([
      { kind: "box_set", boxId: BLOCK_BOX, value: text("first", "b1:body") },
      { kind: "box_set", boxId: SECOND_BLOCK_BOX, value: text("second", "b2:body") },
      { kind: "box_set", boxId: COMPOSER_BOX, value: composer("") },
      structure(1, [{ key: "block:m1", boxId: BLOCK_BOX }]),
    ]);
    expect(paintRows(host)[0]).toEqual("first");
    port.emit([
      structure(2, [
        { key: "block:m1", boxId: BLOCK_BOX },
        { key: "block:m2", boxId: SECOND_BLOCK_BOX },
      ]),
    ]);
    const swapped = paintRows(host);
    expect(swapped.slice(0, 2)).toEqual(["first", "second"]);
    port.emit([structure(1, [{ key: "block:m1", boxId: BLOCK_BOX }])]);
    expect(paintRows(host)).toEqual(swapped);
    host.stop();
  }

  {
    const { host, port } = makeHost();
    host.start();
    port.emit([
      { kind: "box_set", boxId: BLOCK_BOX, value: text("transient", "b1:body") },
      { kind: "box_set", boxId: COMPOSER_BOX, value: composer("") },
      structure(1, [{ key: "block:m1", boxId: BLOCK_BOX }]),
    ]);
    const filled = paintRows(host);
    port.emit([{ kind: "box_free", boxIds: [BLOCK_BOX] }]);
    const freed = paintRows(host);
    expect({
      filled: filled.some((row) => row.includes("transient")),
      emptied: freed.some((row) => row.includes("transient")),
      gen: host.mailbox.structureGen,
      composer: freed.some((row) => row.includes("╭")),
    }).toEqual({
      filled: true,
      emptied: false,
      gen: 1,
      composer: true,
    });
    host.stop();
  }

  {
    const { host, port } = makeHost();
    host.start();
    let threw = false;
    try {
      port.emit([{ kind: "structure", gen: 1, tree: "not a tree" }]);
    } catch {
      threw = true;
    }
    expect({ threw, blank: paintRows(host).join("") }).toEqual({ threw: false, blank: "" });
    host.stop();
  }
});

test("paint_init opens the delivery gate", () => {
  let ready = 0;
  const { host, port } = makeHost({
    onReady: () => {
      ready += 1;
    },
  });
  host.start();
  port.emit([{ kind: "paint_init" }]);
  expect(ready).toBe(1);
  port.emit([{ kind: "paint_init" }]);
  expect(ready).toBe(1);
  host.stop();
});

test("prepare() root is the frame; mailbox leftover is not merged", () => {
  const paintLocal = createPaintLocal(40, 8);
  const source = stubSource({
    root: {
      type: "text",
      key: "retained",
      content: "RETAINED",
      paintReady: true,
    },
    composer: { draft: "kept", cursor: 4, mark: null, interactive: true },
    birthSites: [],
    progressSites: [],
    picker: null,
  });
  const { host, port, output } = makeHost({ paintSource: source, paintLocal });
  host.start();
  port.emit([
    structure(1, [{ key: "transcript", boxId: BLOCK_BOX }]),
    { kind: "box_set", boxId: BLOCK_BOX, value: text("MAILBOX", "mailbox") },
  ]);
  const plain = stripSgr(output.writes.join(""));
  expect(plain).toContain("RETAINED");
  expect(plain).not.toContain("MAILBOX");
  host.stop();
});

test("null prepare() root keeps the mailbox path", () => {
  const paintLocal = createPaintLocal(40, 8);
  const source = stubSource({
    root: null,
    composer: { draft: "", cursor: 0, mark: null, interactive: true },
    birthSites: [],
    progressSites: [],
    picker: null,
  });
  const { host, port, output } = makeHost({ paintSource: source, paintLocal });
  host.start();
  port.emit([
    structure(1, [{ key: "transcript", boxId: BLOCK_BOX }]),
    { kind: "box_set", boxId: BLOCK_BOX, value: text("MAILBOX", "mailbox") },
  ]);
  expect(stripSgr(output.writes.join(""))).toContain("MAILBOX");
  host.stop();
});

test("retained prepare() root opens the delivery gate", () => {
  let ready = 0;
  const paintLocal = createPaintLocal(40, 12);
  const source = stubSource({
    root: {
      type: "text",
      key: "retained",
      content: "HI",
      paintReady: true,
    },
    composer: { draft: "", cursor: 0, mark: null, interactive: true },
    birthSites: [],
    progressSites: [],
    picker: null,
  });
  const { host, port, input } = makeHost({
    paintSource: source,
    paintLocal,
    onReady: () => {
      ready += 1;
    },
  });
  host.start();
  expect(ready).toBe(1);
  const before = port.posted.length;
  input.type("j");
  expect(port.posted.slice(before)).toEqual([{ kind: "input_events", events: [{ key: "j" }] }]);
  host.stop();
});

test("bare click on toggle_collapsed calls paintSource.toggleCollapsed", () => {
  const toggled: string[] = [];
  const paintLocal = createPaintLocal(40, 12);
  const source: RetainedPaintSource = {
    ...stubSource({
      root: {
        type: "box",
        key: "paint:1",
        intent: "activate",
        onClick: { type: "toggle_collapsed", blockId: "paint:1" },
        userSelect: "none",
        style: { width: 40, height: 12 },
        paintReady: true,
        children: [{ type: "text", key: "paint:1:t", content: "CLICK", paintReady: true }],
      },
      composer: { draft: "", cursor: 0, mark: null, interactive: true },
      birthSites: [],
      progressSites: [],
      picker: null,
    }),
    toggleCollapsed(blockId) {
      toggled.push(blockId);
    },
  };
  const { host, port } = makeHost({ paintSource: source, paintLocal });
  host.start();
  host.onClick(2, 2);
  expect(toggled).toEqual(["paint:1"]);
  expect(port.posted.filter((m) => m.kind === "activate")).toEqual([]);
  host.stop();
});

test("bare click on intent:activate posts activate{key}", () => {
  const paintLocal = createPaintLocal(40, 12);
  const source = stubSource({
    root: {
      type: "box",
      key: "s-foo",
      intent: "activate",
      userSelect: "none",
      style: { width: 40, height: 12 },
      paintReady: true,
      children: [{ type: "text", key: "s-foo:t", content: "CLICK", paintReady: true }],
    },
    composer: { draft: "", cursor: 0, mark: null, interactive: true },
    birthSites: [],
    progressSites: [],
    picker: null,
  });
  const { host, port } = makeHost({ paintSource: source, paintLocal });
  host.start();
  host.onClick(2, 2);
  expect(port.posted.filter((m) => m.kind === "activate")).toEqual([{ kind: "activate", key: "s-foo" }]);
  host.stop();
});

test("bgFx field keeps the live timer", () => {
  const paintLocal = createPaintLocal(40, 12);
  const loops = new CountingLoopFactory();
  const source = stubSource({
    root: {
      type: "box",
      key: "fx",
      paintReady: true,
      style: { width: 40, height: 12, background: { bgFx: "gradient" } },
      children: [],
    },
    composer: { draft: "", cursor: 0, mark: null, interactive: true },
    birthSites: [],
    progressSites: [],
    picker: null,
    contentIdentity: "fx",
  });
  const { host, output } = makeHost({
    paintSource: source,
    paintLocal,
    loop: loops,
    targetFps: 120,
    sync2026: true,
  });
  host.start();
  expect({
    armed: loops.active.length,
    hz: loops.active[0]?.hz ?? 0,
    sync: output.writes.some((w) => w.includes("\x1b[?2026h") && w.includes("\x1b[?2026l")),
  }).toEqual({ armed: 1, hz: 30, sync: true });
  host.stop();
});

test("live spinner ticks reuse the Frame", () => {
  const paintLocal = createPaintLocal(40, 12);
  const loops = new CountingLoopFactory();
  let now = 0;
  const reused: boolean[] = [];
  const prepared: PreparedPaint = {
    root: {
      type: "box",
      key: "root",
      paintReady: true,
      style: { width: 40, height: 12 },
      children: [
        {
          type: "text",
          key: "spin",
          content: "x",
          live: spinnerLive("thinking"),
          paintReady: true,
        },
      ],
    },
    composer: { draft: "", cursor: 0, mark: null, interactive: true },
    birthSites: [],
    progressSites: [],
    picker: null,
  };
  const { host } = makeHost({
    paintSource: stubSource(prepared),
    paintLocal,
    loop: loops,
    now: () => now,
    onPresent: (info) => {
      reused.push(info.reusedFrame);
    },
  });
  host.start();
  now = 200;
  loops.active[0]?.fire();
  now = 400;
  loops.active[0]?.fire();
  expect({ first: reused[0], later: reused.slice(1) }).toEqual({
    first: false,
    later: [true, true],
  });
  host.stop();
});

test("live tick reads snapshot and does not pull prepare()", () => {
  const paintLocal = createPaintLocal(40, 12);
  const loops = new CountingLoopFactory();
  let prepares = 0;
  const prepared: PreparedPaint = {
    root: {
      type: "box",
      key: "fx",
      paintReady: true,
      style: { width: 40, height: 12, background: { bgFx: "gradient" } },
      children: [],
    },
    composer: { draft: "", cursor: 0, mark: null, interactive: false },
    birthSites: [],
    progressSites: [],
    picker: null,
    contentIdentity: "fx",
  };
  const source: RetainedPaintSource = {
    get snapshot() {
      return prepared;
    },
    bind() {
      return { [Symbol.dispose]() {} };
    },
    prepare() {
      prepares += 1;
      return prepared;
    },
  };
  const { host } = makeHost({
    paintSource: source,
    paintLocal,
    loop: loops,
    targetFps: 120,
  });
  host.start();
  expect(prepares).toBe(0);
  loops.active[0]?.fire();
  expect(prepares).toBe(0);
  host.stop();
});

test("attune dark→light dirties resolved wash RGB", () => {
  const presents: Array<{ dirtyRows: number; reusedFrame: boolean }> = [];
  const prepared: PreparedPaint = {
    root: {
      type: "text",
      key: "wash",
      content: "add",
      paintReady: true,
      style: { role: "diff_add", bgRole: "diff_add", bgProminence: 1 },
    },
    composer: { draft: "", cursor: 0, mark: null, interactive: true },
    birthSites: [],
    progressSites: [],
    picker: null,
    contentIdentity: "wash",
  };
  const { host } = makeHost({
    paintSource: stubSource(prepared),
    paintLocal: createPaintLocal(40, 8),
    theme: attuneTheme({ ground: 0.2, depth: "truecolor" }),
    onPresent: (info) => presents.push({ dirtyRows: info.dirtyRows, reusedFrame: info.reusedFrame }),
  });
  host.start();
  host.attune({ ground: 0.85 });
  expect({
    paints: presents.length,
    secondDirty: (presents[1]?.dirtyRows ?? 0) > 0,
    secondReuseBuffer: presents[1]?.reusedFrame,
  }).toEqual({
    paints: 2,
    secondDirty: true,
    secondReuseBuffer: false,
  });
  host.stop();
});

test("live OSC 11 attunes without typing into the draft", () => {
  const presents: number[] = [];
  const prepared: PreparedPaint = {
    root: {
      type: "text",
      key: "wash",
      content: "add",
      paintReady: true,
      style: { role: "diff_add", bgRole: "diff_add", bgProminence: 1 },
    },
    composer: { draft: "", cursor: 0, mark: null, interactive: true },
    birthSites: [],
    progressSites: [],
    picker: null,
    contentIdentity: "wash",
  };
  const { host, input } = makeHost({
    paintSource: stubSource(prepared),
    paintLocal: createPaintLocal(40, 8),
    theme: attuneTheme({ ground: 0.2, depth: "truecolor" }),
    onPresent: () => presents.push(1),
  });
  host.start();
  input.type("\x1b]11;rgb:ffff/ffff/ffff\x07");
  expect(presents.length).toBe(2);
  host.stop();
});

test("theme notifications query actual ground and repaint retained foreground and diff fill", () => {
  let paints = 0;
  const washStyle = { role: "foreground", prominence: 1, bgRole: "diff_add", bgProminence: 0.28 };
  const prepared: PreparedPaint = {
    root: {
      type: "text",
      key: "wash",
      content: "add",
      paintReady: true,
      style: washStyle,
    },
    composer: { draft: "", cursor: 0, mark: null, interactive: true },
    birthSites: [],
    progressSites: [],
    picker: null,
    contentIdentity: "wash",
  };
  const { host, input, output, port } = makeHost({
    paintSource: stubSource(prepared),
    paintLocal: createPaintLocal(40, 8),
    theme: attuneTheme({ ground: 0.2, depth: "truecolor" }),
    onPresent: () => {
      paints += 1;
    },
  });
  host.start();
  expect(output.writes).toContain(THEME_REPORT_ENABLE + OSC11_QUERY);
  const before = paints;
  const messages = port.posted.length;
  output.writes.length = 0;
  input.type("\x1b[?997;");
  input.type("2n");
  expect(output.writes).toEqual([OSC11_QUERY]);
  expect(paints).toBe(before);
  expect(port.posted.length).toBe(messages);

  output.writes.length = 0;
  input.type("\x1b]11;rgb:f0f0/e1e1/d2d2\x07");
  expect(paints).toBe(before + 1);
  input.type("\x1b]11;rgb:f0f0/e1e1/d2d2\x07");
  expect(paints).toBe(before + 1);
  output.writes.length = 0;
  input.type("\x1b[I");
  expect(output.writes).toContain(OSC11_QUERY);
  const beforeDepth = paints;
  output.writes.length = 0;
  host.attune({ depth: "ansi256" });
  expect(paints).toBe(beforeDepth + 1);
  expect(output.writes.join("")).toMatch(/(?:\[|;)48;5;/u);
  host.stop();
  expect(output.writes.at(-1)).toBe(THEME_REPORT_DISABLE);
});

test("non-interactive retained composer does not predict echo", () => {
  const paintLocal = createPaintLocal(40, 12);
  const source = stubSource({
    root: {
      type: "text",
      key: "demo",
      content: "HI",
      paintReady: true,
    },
    composer: { draft: "", cursor: 0, mark: null, interactive: false },
    birthSites: [],
    progressSites: [],
    picker: null,
    contentIdentity: "demo",
  });
  const { host, input } = makeHost({ paintSource: source, paintLocal });
  host.start();
  input.type("j");
  expect(paintLocal.echo.predicted).toBeNull();
  host.stop();
});

test("armed Ctrl-C paints quitAction; second press quits", () => {
  const quits: number[] = [];
  const actions: string[] = [];
  const { host, port, input } = makeHost({
    onQuit: () => {
      quits.push(1);
    },
    quitAction: () => {
      const action = "exit the UI and keep session running in background";
      actions.push(action);
      return action;
    },
  });
  host.start();
  port.emit([structure(1, []), { kind: "box_set", boxId: COMPOSER_BOX, value: composer("hi") }]);
  input.type("\x03");
  expect({ actions: actions.slice(-1), quits }).toEqual({
    actions: ["exit the UI and keep session running in background"],
    quits: [],
  });
  input.type("\x03");
  expect(quits).toEqual([1]);
  host.stop();
});

test("isolated Super/Control latches modHeld; a later glyph does not clear it", () => {
  const paintLocal = createPaintLocal(40, 12);
  const { host, input } = makeHost({
    paintSource: stubSource({
      root: { type: "text", key: "demo", content: "HI", paintReady: true },
      composer: { draft: "", cursor: 0, mark: null, interactive: true },
      birthSites: [],
      progressSites: [],
      picker: null,
    }),
    paintLocal,
  });
  host.start();
  expect(paintLocal.modHeld).toBe(false);
  input.type("\x1b[57444u");
  expect(paintLocal.modHeld).toBe(true);
  input.type("j");
  expect(paintLocal.modHeld).toBe(true);
  input.type("\x1b[57444;1:3u");
  expect(paintLocal.modHeld).toBe(false);
  input.type("\x1b[57444;9u");
  expect(paintLocal.modHeld).toBe(true);
  input.type("\x1b[57444;9:3u");
  expect(paintLocal.modHeld).toBe(false);
  host.stop();
});
