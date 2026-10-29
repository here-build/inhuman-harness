import { expect, test, vi } from "vitest";

import {
  BLOCK_BOX,
  COMPOSER_BOX,
  FakeBoxCadencePort,
  FakeTtyInput,
  FakeTtyOutput,
  bufferRows,
  composer,
} from "./_helpers.js";
import { clear, createBuffer } from "../../buffer/index.js";
import {
  attuneTheme,
  CHROME_FRAME_CORNERS,
  layout,
  paintFrame,
  selectionRangeEnd,
  type LayoutNode,
} from "../../layout/index.js";
import { FgP } from "../../lexicon/index.js";
import {
  COPY_TOAST_ARM_MS,
  COPY_TOAST_HOLD_MS,
  COPY_TOAST_TEXT,
  paintCopyToast,
  placeCopyToast,
} from "../copy_toast.js";
import { Renderer } from "../renderer.js";

const syncSchedule = (fn: () => void): void => fn();

function sgr(button: number, col: number, row: number, release = false): string {
  return `\x1b[<${button};${col};${row}${release ? "m" : "M"}`;
}

function selectableText(value: string, key: string): LayoutNode {
  return { type: "text", key, content: value, userSelect: "text", whiteSpace: "nowrap" };
}

function selectableStructure(
  gen: number,
  blockKeys: readonly { key: string; boxId: number }[],
): import("../box_bus.js").BoxBusDownMessage {
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

function osc52Payloads(writes: string): string[] {
  return [...writes.matchAll(/\x1b\]52;[^;]*;([A-Z0-9+/=]*)\x07/gi)].map((m) =>
    Buffer.from(m[1]!, "base64").toString("utf8").replace(/\n+$/u, ""),
  );
}

function stripAnsi(s: string): string {
  return s
    .replaceAll(/\x1b\][^\x07]*\x07/g, "")
    .replaceAll(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replaceAll(/\x1b./g, "");
}

function motion1003(writes: readonly string[]): Array<"h" | "l"> {
  return [...writes.join("").matchAll(/\x1b\[\?1003([hl])/g)].map((m) => m[1] as "h" | "l");
}

function toastCells(
  buf: ReturnType<typeof createBuffer>,
  place: { x: number; y: number; w: number; h: number },
): {
  rows: string[];
  rim: { role?: string; prominence?: number };
  ink: { role?: string; prominence?: number };
} {
  const rows: string[] = [];
  for (let r = 0; r < place.h; r++) {
    let line = "";
    for (let c = 0; c < place.w; c++) {
      line += buf.cells[(place.y + r) * buf.width + (place.x + c)]?.ch ?? " ";
    }
    rows.push(line);
  }
  const rim = buf.cells[place.y * buf.width + place.x]!.style;
  const ink = buf.cells[(place.y + 1) * buf.width + (place.x + 2)]!.style;
  return {
    rows,
    rim: { role: rim.role, prominence: rim.prominence },
    ink: { role: ink.role, prominence: ink.prominence },
  };
}

test("copy toast sits on the range-end side, clamped, omnibox rim + primary ink", () => {
  const down = placeCopyToast({
    end: { col: 10, row: 2 },
    anchor: { col: 4, row: 0 },
    cols: 40,
    rows: 12,
  });
  const up = placeCopyToast({
    end: { col: 10, row: 5 },
    anchor: { col: 10, row: 8 },
    cols: 40,
    rows: 12,
  });
  const left = placeCopyToast({
    end: { col: 0, row: 2 },
    anchor: { col: 0, row: 0 },
    cols: 40,
    rows: 12,
  });
  const lastRow = placeCopyToast({
    end: { col: 10, row: 11 },
    anchor: { col: 10, row: 8 },
    cols: 40,
    rows: 12,
  });
  const flipUp = placeCopyToast({
    end: { col: 10, row: 1 },
    anchor: { col: 10, row: 5 },
    cols: 40,
    rows: 12,
  });

  const shortFrame = layout(
    {
      type: "box",
      userSelect: "text",
      style: { width: 40, height: 3 },
      children: [
        {
          type: "text",
          content: "hello",
          userSelect: "text",
          whiteSpace: "nowrap",
        },
      ],
    },
    { w: 40, h: 3 },
  );
  const shortBuf = createBuffer(40, 3);
  clear(shortBuf);
  paintFrame(shortFrame, shortBuf);
  const pastGlyphs = {
    anchor: { col: 0, row: 0 },
    active: { col: 20, row: 0 },
    granularity: "char" as const,
  };
  const rangeEnd = selectionRangeEnd(pastGlyphs, shortBuf, shortFrame);
  const fromRange = placeCopyToast({
    end: rangeEnd,
    anchor: pastGlyphs.anchor,
    cols: 40,
    rows: 12,
  });
  const fromPointer = placeCopyToast({
    end: pastGlyphs.active,
    anchor: pastGlyphs.anchor,
    cols: 40,
    rows: 12,
  });

  const { paint } = attuneTheme({ depth: "truecolor" });
  const buf = createBuffer(40, 12);
  clear(buf);
  paintCopyToast(buf, down, (style) => paint.resolveStyle(style));
  const dump = toastCells(buf, down);

  expect({
    down,
    up,
    left: { x: left.x, side: left.side },
    lastRow: { y: lastRow.y, side: lastRow.side },
    flipUp: { y: flipUp.y, side: flipUp.side },
    rangeEnd,
    fromRange: fromRange.x,
    fromPointer: fromPointer.x,
    dump,
    screenHasCopied: bufferRows(buf).some((row) => row.includes(COPY_TOAST_TEXT)),
  }).toEqual({
    down: { x: 6, y: 3, w: 10, h: 3, side: "below" },
    up: { x: 6, y: 2, w: 10, h: 3, side: "above" },
    left: { x: 0, side: "below" },
    lastRow: { y: 8, side: "above" },
    flipUp: { y: 2, side: "below" },
    rangeEnd: { col: 4, row: 0 },
    fromRange: 0,
    fromPointer: 16,
    dump: {
      rows: [
        `${CHROME_FRAME_CORNERS.tl}${"─".repeat(8)}${CHROME_FRAME_CORNERS.tr}`,
        `│ ${COPY_TOAST_TEXT} │`,
        `${CHROME_FRAME_CORNERS.bl}${"─".repeat(8)}${CHROME_FRAME_CORNERS.br}`,
      ],
      rim: { role: "foreground", prominence: FgP.ghost },
      ink: { role: "foreground", prominence: FgP.primary },
    },
    screenHasCopied: true,
  });
});

test("Copied chrome: copy shows, press kills now, input/move after 3s, hold 10s", () => {
  vi.useFakeTimers();
  let presents = 0;
  const input = new FakeTtyInput();
  const output = new FakeTtyOutput(40, 12);
  const port = new FakeBoxCadencePort();
  const host = new Renderer({
    port,
    input,
    output,
    now: () => 0,
    schedule: syncSchedule,
    onPresent: () => {
      presents += 1;
    },
    composerBoxKey: "composer",
    composerFrameKey: "composer:frame",
  });
  host.start();
  const dragCopy = () => {
    input.type(sgr(0, 1, 1, false));
    input.type(sgr(32, 11, 1, false));
    input.type(sgr(0, 11, 1, true));
  };
  try {
    port.emit([
      { kind: "box_set", boxId: BLOCK_BOX, value: selectableText("hello world", "block:m1") },
      { kind: "box_set", boxId: COMPOSER_BOX, value: composer("") },
      selectableStructure(1, [{ key: "block:m1", boxId: BLOCK_BOX }]),
    ]);
    dragCopy();
    const afterCopy = output.writes.join("");
    const atKeyEarly = output.writes.length;
    input.type("x");
    output.resize(40, 12);
    const keptAfterKey = stripAnsi(output.writes.slice(atKeyEarly).join("")).includes(COPY_TOAST_TEXT);
    const atPress = output.writes.length;
    input.type(sgr(0, 20, 6, false));
    const pressKills = !stripAnsi(output.writes.slice(atPress).join("")).includes(COPY_TOAST_TEXT);

    dragCopy();
    vi.advanceTimersByTime(COPY_TOAST_ARM_MS);
    const armed1003 = motion1003(output.writes).includes("h");
    const atKey = output.writes.length;
    input.type("y");
    const keyAfterArmKills = !stripAnsi(output.writes.slice(atKey).join("")).includes(COPY_TOAST_TEXT);

    dragCopy();
    vi.advanceTimersByTime(COPY_TOAST_ARM_MS);
    const atMove = output.writes.length;
    input.type(sgr(35, 3, 3, false));
    const moveAfterArmKills = !stripAnsi(output.writes.slice(atMove).join("")).includes(COPY_TOAST_TEXT);

    dragCopy();
    vi.advanceTimersByTime(COPY_TOAST_ARM_MS);
    const atWheel = output.writes.length;
    input.type(sgr(64, 1, 1, false));
    const wheelAfterArmKills = !stripAnsi(output.writes.slice(atWheel).join("")).includes(COPY_TOAST_TEXT);

    dragCopy();
    const atHold = output.writes.length;
    const presentsBeforeHold = presents;
    vi.advanceTimersByTime(COPY_TOAST_HOLD_MS);
    const holdKills = !stripAnsi(output.writes.slice(atHold).join("")).includes(COPY_TOAST_TEXT);
    const holdPresented = presents > presentsBeforeHold;

    expect({
      copy: osc52Payloads(output.writes.join("")),
      shown: stripAnsi(afterCopy).includes(COPY_TOAST_TEXT),
      rim: stripAnsi(afterCopy).includes(CHROME_FRAME_CORNERS.tl),
      keptAfterKey,
      pressKills,
      armed1003,
      keyAfterArmKills,
      moveAfterArmKills,
      wheelAfterArmKills,
      holdKills,
      holdPresented,
    }).toEqual({
      copy: ["hello world", "hello world", "hello world", "hello world", "hello world"],
      shown: true,
      rim: true,
      keptAfterKey: true,
      pressKills: true,
      armed1003: true,
      keyAfterArmKills: true,
      moveAfterArmKills: true,
      wheelAfterArmKills: true,
      holdKills: true,
      holdPresented: true,
    });
  } finally {
    host.stop();
    vi.useRealTimers();
  }
});

test("copy toast hold presents even when coalesced schedule is swallowed", () => {
  vi.useFakeTimers();
  let presents = 0;
  const input = new FakeTtyInput();
  const output = new FakeTtyOutput(40, 12);
  const port = new FakeBoxCadencePort();
  const host = new Renderer({
    port,
    input,
    output,
    now: () => 0,
    schedule: () => {
      /* swallow requestPaint — hold must tick() */
    },
    onPresent: () => {
      presents += 1;
    },
    composerBoxKey: "composer",
    composerFrameKey: "composer:frame",
  });
  host.start();
  try {
    port.emit([
      { kind: "box_set", boxId: BLOCK_BOX, value: selectableText("hello world", "block:m1") },
      { kind: "box_set", boxId: COMPOSER_BOX, value: composer("") },
      selectableStructure(1, [{ key: "block:m1", boxId: BLOCK_BOX }]),
    ]);
    input.type(sgr(0, 1, 1, false));
    input.type(sgr(32, 11, 1, false));
    input.type(sgr(0, 11, 1, true));
    const afterCopy = presents;
    vi.advanceTimersByTime(COPY_TOAST_HOLD_MS);
    expect({
      copy: osc52Payloads(output.writes.join("")),
      afterCopy: afterCopy > 0,
      holdPresented: presents > afterCopy,
    }).toEqual({
      copy: ["hello world"],
      afterCopy: true,
      holdPresented: true,
    });
  } finally {
    host.stop();
    vi.useRealTimers();
  }
});
