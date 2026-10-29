import { expect, test, vi } from "vitest";

import { clear, createBuffer } from "../../buffer/index.js";
import { layout, paintFrame, type LayoutNode } from "../../layout/index.js";
import type { BoxBusDownMessage } from "../box_bus.js";
import { parseComposerCaretEvent, parsePasteKeyEvent } from "../keys.js";
import { Renderer, ESC_QUIET_MS, SELECTION_PAINT_HZ } from "../renderer.js";
import { createSelectionHost, mouseToGesture } from "../selection_host.js";
import { BLOCK_BOX, COMPOSER_BOX, FakeBoxCadencePort, FakeTtyInput, FakeTtyOutput, composer } from "./_helpers.js";

const syncSchedule = (fn: () => void): void => fn();

function sgr(button: number, col: number, row: number, release = false): string {
  return `\x1b[<${button};${col};${row}${release ? "m" : "M"}`;
}

function selectableStructure(gen: number, blockKeys: readonly { key: string; boxId: number }[]): BoxBusDownMessage {
  return {
    kind: "structure",
    gen,
    tree: {
      root: {
        type: "flex",
        key: "root",
        style: { direction: "column" },
        children: [
          ...blockKeys.map(({ key }) => ({ type: "box", key, userSelect: "text", children: [] }) as LayoutNode),
          { type: "box", key: "composer", children: [] } as LayoutNode,
        ],
      },
      boxes: Object.fromEntries([...blockKeys.map(({ key, boxId }) => [key, boxId]), ["composer", COMPOSER_BOX]]),
    },
  };
}

function selectableText(value: string, key: string): LayoutNode {
  return { type: "text", key, content: value, userSelect: "text", whiteSpace: "nowrap" };
}

function osc52Payloads(writes: string): string[] {
  return [...writes.matchAll(/\x1b\]52;[^;]*;([A-Z0-9+/=]*)\x07/gi)].map((m) =>
    Buffer.from(m[1]!, "base64").toString("utf8").replace(/\n+$/u, ""),
  );
}

test("OSC52 + gen/reflow", () => {
  expect({
    press: mouseToGesture({ button: 0, col: 5, row: 3, release: false }, 100),
    drag: mouseToGesture({ button: 32, col: 8, row: 3, release: false }, 110),
    release: mouseToGesture({ button: 0, col: 8, row: 3, release: true }, 120),
    wheelUp: mouseToGesture({ button: 64, col: 1, row: 1, release: false }, 0),
    wheelDown: mouseToGesture({ button: 65, col: 1, row: 1, release: false }, 0),
    wheelH: mouseToGesture({ button: 66, col: 1, row: 1, release: false }, 0).kind,
    move: mouseToGesture({ button: 35, col: 2, row: 2, release: false }, 0),
    moveRelease: mouseToGesture({ button: 35, col: 2, row: 2, release: true }, 0),
  }).toEqual({
    press: {
      kind: "gesture",
      event: { kind: "press", col: 4, row: 2, tMs: 100, shift: false, alt: false, ctrl: false },
    },
    drag: {
      kind: "gesture",
      event: { kind: "drag", col: 7, row: 2, tMs: 110, shift: false, alt: false, ctrl: false },
    },
    release: {
      kind: "gesture",
      event: { kind: "release", col: 7, row: 2, tMs: 120, shift: false, alt: false, ctrl: false },
    },
    wheelUp: { kind: "wheel", delta: -1 },
    wheelDown: { kind: "wheel", delta: 1 },
    wheelH: "ignore",
    move: { kind: "move" },
    moveRelease: { kind: "ignore" },
  });

  const w = 20;
  const h = 3;
  const tree = {
    type: "box" as const,
    key: "body",
    userSelect: "text" as const,
    style: { width: w, height: h },
    children: [
      {
        type: "text" as const,
        key: "t",
        content: "hello world",
        userSelect: "text" as const,
        whiteSpace: "nowrap" as const,
      },
    ],
  };
  const frame = layout(tree, { w, h });
  const buf = createBuffer(w, h);
  clear(buf);
  paintFrame(frame, buf);
  const selection = createSelectionHost();
  selection.setViewport(w, h);
  selection.bindPaint(buf, frame);
  selection.handle({ kind: "press", col: 0, row: 0, tMs: 0 });
  const bare = selection.handle({ kind: "release", col: 0, row: 0, tMs: 10 });
  selection.handle({ kind: "press", col: 0, row: 0, tMs: 100 });
  selection.handle({ kind: "drag", col: 4, row: 0, tMs: 110 });
  const dragged = selection.handle({ kind: "release", col: 4, row: 0, tMs: 120 });
  const painted = createBuffer(w, h);
  clear(painted);
  paintFrame(frame, painted);
  selection.bindPaint(painted, frame);
  const recolored = selection.recolor(painted, frame, 0);
  expect({
    bare: { selection: bare.selection, copyReady: bare.copyReady },
    drag: { hasSelection: dragged.selection !== null, copyReady: dragged.copyReady },
    recolored,
    selected: painted.cells.some((c) => c?.style?.selected) === true,
    osc: osc52Payloads(selection.copyOscIfReady(dragged)),
  }).toEqual({
    bare: { selection: null, copyReady: false },
    drag: { hasSelection: true, copyReady: true },
    recolored: true,
    selected: true,
    osc: ["hello"],
  });

  const hosts: Renderer[] = [];
  const harness = () => {
    const input = new FakeTtyInput();
    const output = new FakeTtyOutput(40, 12);
    const port = new FakeBoxCadencePort();
    const host = new Renderer({
      port,
      input,
      output,
      now: () => 0,
      schedule: syncSchedule,
      composerBoxKey: "composer",
      composerFrameKey: "composer:frame",
    });
    host.start();
    hosts.push(host);
    return { input, output, port };
  };
  const seedSelectable = (port: FakeBoxCadencePort, gen = 1) => {
    port.emit([
      { kind: "box_set", boxId: BLOCK_BOX, value: selectableText("hello world", "block:m1") },
      { kind: "box_set", boxId: COMPOSER_BOX, value: composer("") },
      selectableStructure(gen, [{ key: "block:m1", boxId: BLOCK_BOX }]),
    ]);
  };

  try {
    {
      const { input, output, port } = harness();
      seedSelectable(port);
      input.type(sgr(0, 1, 1, false));
      input.type(sgr(32, 5, 1, false));
      input.type(sgr(0, 5, 1, true));
      expect(osc52Payloads(output.writes.join("")).length > 0).toEqual(true);
    }

    {
      const { input, output, port } = harness();
      seedSelectable(port);
      input.type(sgr(0, 1, 1, false));
      input.type(sgr(32, 5, 1, false));
      port.emit([
        selectableStructure(2, [
          { key: "block:m1", boxId: BLOCK_BOX },
          { key: "block:m2", boxId: BLOCK_BOX + 1 },
        ]),
      ]);
      const writesBeforeRelease = output.writes.length;
      input.type(sgr(0, 5, 1, true));
      expect(osc52Payloads(output.writes.slice(writesBeforeRelease).join(""))).toEqual([]);
    }

    {
      const { input, output, port } = harness();
      seedSelectable(port, 2);
      input.type(sgr(0, 1, 1, false));
      input.type(sgr(32, 5, 1, false));
      port.emit([selectableStructure(1, [{ key: "block:m1", boxId: BLOCK_BOX }])]);
      input.type(sgr(0, 5, 1, true));
      expect(osc52Payloads(output.writes.join("")).length > 0).toEqual(true);
    }

    {
      const { input, output, port } = harness();
      const original = "SECOND";
      const reflowed = "GROWN2";
      port.emit([
        { kind: "box_set", boxId: BLOCK_BOX, value: selectableText(original, "block:m1") },
        { kind: "box_set", boxId: COMPOSER_BOX, value: composer("") },
        selectableStructure(1, [{ key: "block:m1", boxId: BLOCK_BOX }]),
      ]);
      input.type(sgr(0, 1, 1, false));
      input.type(sgr(32, 6, 1, false));
      port.emit([{ kind: "box_set", boxId: BLOCK_BOX, value: selectableText(reflowed, "block:m1") }]);
      const writesBeforeRelease = output.writes.length;
      input.type(sgr(0, 6, 1, true));
      expect(osc52Payloads(output.writes.slice(writesBeforeRelease).join(""))).toEqual([]);
    }

    {
      const { input, output, port } = harness();
      const original = "SECOND";
      port.emit([
        { kind: "box_set", boxId: BLOCK_BOX, value: selectableText(original, "block:m1") },
        { kind: "box_set", boxId: COMPOSER_BOX, value: composer("") },
        selectableStructure(1, [{ key: "block:m1", boxId: BLOCK_BOX }]),
      ]);
      input.type(sgr(0, 1, 1, false));
      input.type(sgr(32, 6, 1, false));
      input.type(sgr(0, 6, 1, true));
      expect(osc52Payloads(output.writes.join(""))).toEqual([original]);
    }
  } finally {
    for (const host of hosts) host.stop();
  }
});

test("drag-select coalesces SGR cells to one present per 30fps window", () => {
  const now = 0;
  let presents = 0;
  const input = new FakeTtyInput();
  const output = new FakeTtyOutput(40, 12);
  const port = new FakeBoxCadencePort();
  const host = new Renderer({
    port,
    input,
    output,
    now: () => now,
    schedule: syncSchedule,
    onPresent: () => {
      presents += 1;
    },
    composerBoxKey: "composer",
    composerFrameKey: "composer:frame",
  });
  vi.useFakeTimers();
  host.start();
  try {
    port.emit([
      { kind: "box_set", boxId: BLOCK_BOX, value: selectableText("hello world", "block:m1") },
      { kind: "box_set", boxId: COMPOSER_BOX, value: composer("") },
      selectableStructure(1, [{ key: "block:m1", boxId: BLOCK_BOX }]),
    ]);
    input.type(sgr(0, 1, 1, false));
    const afterPress = presents;
    input.type(Array.from({ length: 20 }, (_, i) => sgr(32, 2 + i, 1)).join(""));
    const afterBurst = presents - afterPress;
    vi.advanceTimersByTime(Math.ceil(1000 / SELECTION_PAINT_HZ) + 1);
    const afterTrail = presents - afterPress;
    input.type(sgr(0, 11, 1, true));
    expect({
      afterBurst,
      afterTrail,
      copy: osc52Payloads(output.writes.join("")),
    }).toEqual({
      afterBurst: 1,
      afterTrail: 2,
      copy: ["hello world"],
    });
  } finally {
    host.stop();
    vi.useRealTimers();
  }
});

test("composer selection: backspace deletes the range, ctrl-v pastes over it", () => {
  const postedKeys = (port: FakeBoxCadencePort) =>
    port.posted.flatMap((m) => (m.kind === "input_events" ? m.events : []));
  const seed = (port: FakeBoxCadencePort) => {
    port.emit([{ kind: "box_set", boxId: COMPOSER_BOX, value: composer("hello world") }, selectableStructure(1, [])]);
  };
  // chrome_frame at y=0, body y=1, text inset 3. SGR 1-based: row 2, col 4 = 'h'.
  const dragHello = (input: FakeTtyInput) => {
    input.type(sgr(0, 4, 2, false));
    input.type(sgr(32, 8, 2, false));
    input.type(sgr(0, 8, 2, true));
  };

  const backspace = (() => {
    const input = new FakeTtyInput();
    const output = new FakeTtyOutput(40, 12);
    const port = new FakeBoxCadencePort();
    const host = new Renderer({
      port,
      input,
      output,
      now: () => 0,
      schedule: syncSchedule,
      composerBoxKey: "composer",
      composerFrameKey: "composer:frame",
      readClipboard: () => "",
    });
    host.start();
    try {
      seed(port);
      dragHello(input);
      const selected = postedKeys(port);
      input.type("\x7f");
      const after = postedKeys(port);
      return {
        caret: selected.map((e) => parseComposerCaretEvent(e)).find((c) => c !== null) ?? null,
        backspace: after.some((e) => e.key === "Backspace"),
      };
    } finally {
      host.stop();
    }
  })();

  const paste = (() => {
    const input = new FakeTtyInput();
    const output = new FakeTtyOutput(40, 12);
    const port = new FakeBoxCadencePort();
    const host = new Renderer({
      port,
      input,
      output,
      now: () => 0,
      schedule: syncSchedule,
      composerBoxKey: "composer",
      composerFrameKey: "composer:frame",
      readClipboard: () => "xyz",
    });
    host.start();
    try {
      seed(port);
      dragHello(input);
      input.type("\x16");
      return (
        postedKeys(port)
          .map((e) => parsePasteKeyEvent(e))
          .find((t) => t !== null) ?? null
      );
    } finally {
      host.stop();
    }
  })();

  expect({ backspace, paste }).toEqual({
    backspace: { caret: { cursor: 5, mark: 0 }, backspace: true },
    paste: "xyz",
  });
});

test("composer selection: typing produces insert over the range, not a collapsed caret", () => {
  const postedKeys = (port: FakeBoxCadencePort) =>
    port.posted.flatMap((m) => (m.kind === "input_events" ? m.events : []));
  const input = new FakeTtyInput();
  const output = new FakeTtyOutput(40, 12);
  const port = new FakeBoxCadencePort();
  const host = new Renderer({
    port,
    input,
    output,
    now: () => 0,
    schedule: syncSchedule,
    composerBoxKey: "composer",
    composerFrameKey: "composer:frame",
  });
  host.start();
  try {
    port.emit([{ kind: "box_set", boxId: COMPOSER_BOX, value: composer("hello world") }, selectableStructure(1, [])]);
    input.type(sgr(0, 4, 2, false));
    input.type(sgr(32, 8, 2, false));
    input.type(sgr(0, 8, 2, true));
    const afterSelect = postedKeys(port).map((e) => ({
      key: e.key,
      caret: parseComposerCaretEvent(e),
    }));
    input.type("x");
    const afterType = postedKeys(port).map((e) => ({
      key: e.key,
      caret: parseComposerCaretEvent(e),
    }));
    expect({ afterSelect, afterType }).toEqual({
      afterSelect: [{ key: "ComposerCaret:5:0", caret: { cursor: 5, mark: 0 } }],
      afterType: [
        { key: "ComposerCaret:5:0", caret: { cursor: 5, mark: 0 } },
        { key: "ComposerCaret:5:0", caret: { cursor: 5, mark: 0 } },
        { key: "x", caret: null },
      ],
    });
  } finally {
    host.stop();
  }
});

test("Esc collapses a composer range and does not deliver Escape", () => {
  vi.useFakeTimers();
  let now = 0;
  const postedKeys = (port: FakeBoxCadencePort) =>
    port.posted.flatMap((m) => (m.kind === "input_events" ? m.events : []));
  const input = new FakeTtyInput();
  const output = new FakeTtyOutput(40, 12);
  const port = new FakeBoxCadencePort();
  const host = new Renderer({
    port,
    input,
    output,
    now: () => now,
    schedule: syncSchedule,
    composerBoxKey: "composer",
    composerFrameKey: "composer:frame",
  });
  host.start();
  try {
    port.emit([{ kind: "box_set", boxId: COMPOSER_BOX, value: composer("hello world") }, selectableStructure(1, [])]);
    input.type(sgr(0, 4, 2, false));
    input.type(sgr(32, 8, 2, false));
    input.type(sgr(0, 8, 2, true));
    input.type("\x1b");
    now = ESC_QUIET_MS + 2;
    vi.advanceTimersByTime(ESC_QUIET_MS + 2);
    const keys = postedKeys(port);
    expect({
      carets: keys.map((e) => parseComposerCaretEvent(e)).filter((c) => c !== null),
      escape: keys.some((e) => e.key === "Escape"),
    }).toEqual({
      carets: [
        { cursor: 5, mark: 0 },
        { cursor: 5, mark: null },
      ],
      escape: false,
    });
  } finally {
    host.stop();
    vi.useRealTimers();
  }
});

test("composer selection survives a release outside the input", () => {
  const postedKeys = (port: FakeBoxCadencePort) =>
    port.posted.flatMap((m) => (m.kind === "input_events" ? m.events : []));
  // Drag "hello" in the composer, then let the pointer leave the input before
  // button-up: the clamped release cell lands on the anchor, which used to
  // collapse the range so insert/backspace acted on a bare caret instead.
  const run = (releaseCol: number, releaseRow: number) => {
    const input = new FakeTtyInput();
    const output = new FakeTtyOutput(40, 12);
    const port = new FakeBoxCadencePort();
    const host = new Renderer({
      port,
      input,
      output,
      now: () => 0,
      schedule: syncSchedule,
      composerBoxKey: "composer",
      composerFrameKey: "composer:frame",
      readClipboard: () => "",
    });
    host.start();
    try {
      port.emit([{ kind: "box_set", boxId: COMPOSER_BOX, value: composer("hello world") }, selectableStructure(1, [])]);
      input.type(sgr(0, 4, 2, false)); // press on 'h' (0-based (3,1))
      input.type(sgr(32, 8, 2, false)); // drag to 0-based (7,1)
      input.type(sgr(0, releaseCol, releaseRow, true));
      input.type("\x7f"); // backspace — should delete the range, not one char
      return (
        postedKeys(port)
          .map((e) => parseComposerCaretEvent(e))
          .filter((c) => c !== null)
          .find((c) => c.mark !== null) ?? null
      );
    } finally {
      host.stop();
    }
  };
  expect({
    inside: run(8, 2),
    anchorColOutside: run(4, 6),
    farOutside: run(2, 10),
  }).toEqual({
    inside: { cursor: 5, mark: 0 },
    anchorColOutside: { cursor: 5, mark: 0 },
    farOutside: { cursor: 5, mark: 0 },
  });
});

test("shift-click extends a standing composer mark", () => {
  const postedKeys = (port: FakeBoxCadencePort) =>
    port.posted.flatMap((m) => (m.kind === "input_events" ? m.events : []));
  const input = new FakeTtyInput();
  const output = new FakeTtyOutput(40, 12);
  const port = new FakeBoxCadencePort();
  const host = new Renderer({
    port,
    input,
    output,
    now: () => 0,
    schedule: syncSchedule,
    composerBoxKey: "composer",
    composerFrameKey: "composer:frame",
  });
  host.start();
  try {
    port.emit([{ kind: "box_set", boxId: COMPOSER_BOX, value: composer("hello world") }, selectableStructure(1, [])]);
    input.type(sgr(0, 4, 2, false));
    input.type(sgr(32, 8, 2, false));
    input.type(sgr(0, 8, 2, true));
    input.type(sgr(4, 10, 2, false));
    input.type(sgr(4, 10, 2, true));
    const carets = postedKeys(port)
      .map((e) => parseComposerCaretEvent(e))
      .filter((c) => c !== null);
    expect(carets).toEqual([
      { cursor: 5, mark: 0 },
      { cursor: 6, mark: 0 },
    ]);
  } finally {
    host.stop();
  }
});
