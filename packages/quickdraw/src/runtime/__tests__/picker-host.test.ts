import { expect, test } from "vitest";

import type { LayoutNode } from "../../layout/index.js";
import { applyBoxBusBatch, emptyMailbox, type BoxBusDownMessage, type BoxBusUpMessage } from "../box_bus.js";
import { emptyEcho } from "../echo.js";
import { renderFrame } from "../frame.js";
import { paintSnapshotFromMailbox } from "../paint_snapshot.js";
import { Renderer } from "../renderer.js";
import {
  BLOCK_BOX,
  COMPOSER_BOX,
  composer,
  FakeBoxCadencePort,
  FakeTtyInput,
  FakeTtyOutput,
  structure,
} from "./_helpers.js";

const GEOMETRY = { cols: 40, rows: 24 };
const syncSchedule = (fn: () => void): void => fn();

type PickerOpts = { n: number; viewport?: number; scrollOffset?: number };

function sgr(button: number, col: number, row: number, release = false): string {
  return `\x1b[<${button};${col};${row}${release ? "m" : "M"}`;
}

function selectableText(value: string, key: string): LayoutNode {
  return { type: "text", key, content: value, userSelect: "text", whiteSpace: "nowrap" };
}

function pickerRows(n: number): Array<{ key: string; name: string }> {
  return Array.from({ length: n }, (_, i) => ({
    key: `choice:${i}:row${i}`,
    name: `row${i}`,
  }));
}

function pickerComposer(opts: {
  n: number;
  viewport?: number;
  scrollOffset?: number;
  selectedIndex?: number;
  width?: number;
}): LayoutNode {
  const viewport = opts.viewport ?? 8;
  const scrollOffset = opts.scrollOffset ?? 0;
  const width = opts.width ?? 40;
  const rows = pickerRows(opts.n);
  const selectedKey = rows[opts.selectedIndex ?? 0]!.key;
  const visible = rows.slice(scrollOffset, scrollOffset + viewport);
  return {
    type: "box",
    key: "composer:stack",
    children: [
      {
        type: "chrome_frame",
        key: "slash-complete",
        width,
        draft: "",
        bodyUserSelect: "none",
        bodySegRows: visible.map((row) => [
          {
            text: row.name,
            role: row.key === selectedKey ? "foreground" : "muted",
            bold: row.key === selectedKey ? true : undefined,
          },
        ]),
        bodyGlyphs: visible.map((row) => (row.key === selectedKey ? "›" : " ")),
        picker: {
          rows,
          selectedKey,
          scrollOffset,
          viewport,
        },
        joinBottom: true,
        plainBottom: true,
      },
      {
        type: "chrome_frame",
        key: "composer:frame",
        width,
        draft: "",
        omitTop: true,
      },
    ],
  };
}

function seedPicker(
  port: FakeBoxCadencePort,
  opts: { n: number; viewport?: number; scrollOffset?: number } = { n: 15 },
): void {
  const batch: BoxBusDownMessage[] = [
    { kind: "box_set", boxId: BLOCK_BOX, value: selectableText("hello world", "block:m1") },
    { kind: "box_set", boxId: COMPOSER_BOX, value: pickerComposer(opts) },
    structure(1, [{ key: "block:m1", boxId: BLOCK_BOX }]),
  ];
  port.emit(batch);
}

function ofKind<K extends BoxBusUpMessage["kind"]>(
  port: FakeBoxCadencePort,
  kind: K,
): Array<Extract<BoxBusUpMessage, { kind: K }>> {
  return port.posted.filter((m): m is Extract<BoxBusUpMessage, { kind: K }> => m.kind === kind);
}

function osc52Payloads(writes: string): string[] {
  return [...writes.matchAll(/\x1b\]52;[^;]*;([A-Z0-9+/=]*)\x07/gi)].map((m) =>
    Buffer.from(m[1]!, "base64").toString("utf8").replace(/\n+$/u, ""),
  );
}

function motion1003(writes: readonly string[]): Array<"h" | "l"> {
  return [...writes.join("").matchAll(/\x1b\[\?1003([hl])/g)].map((m) => m[1] as "h" | "l");
}

function pickerChromeRect(opts: PickerOpts): { x: number; y: number; w: number; h: number } {
  const mailbox = applyBoxBusBatch(emptyMailbox(), [
    { kind: "box_set", boxId: BLOCK_BOX, value: selectableText("hello world", "block:m1") },
    { kind: "box_set", boxId: COMPOSER_BOX, value: pickerComposer(opts) },
    structure(1, [{ key: "block:m1", boxId: BLOCK_BOX }]),
  ]);
  const frame = renderFrame({
    snapshot: paintSnapshotFromMailbox(mailbox),
    geometry: GEOMETRY,
    state: { nowMs: 0, echo: emptyEcho() },
  }).frame;
  return frame!.byKey.get("slash-complete:chrome")!.hitRect;
}

function chrome1(opts: PickerOpts): { col: number; row: number } {
  const rect = pickerChromeRect(opts);
  return {
    col: rect.x + Math.max(1, Math.floor(rect.w / 2)) + 1,
    row: rect.y + Math.max(1, Math.floor(rect.h / 2)) + 1,
  };
}

function pickerBody1(opts: PickerOpts, paintRow = 0): { col: number; row: number } {
  const r = pickerChromeRect(opts);
  return { col: r.x + 2, row: r.y + 2 + paintRow };
}

test("picker host pointer + 1003", () => {
  const hosts: Renderer[] = [];
  const harness = () => {
    const input = new FakeTtyInput();
    const output = new FakeTtyOutput(GEOMETRY.cols, GEOMETRY.rows);
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
    return { host, input, output, port };
  };

  try {
    {
      const { input, port } = harness();
      const opts = { n: 8, viewport: 8 };
      seedPicker(port, opts);
      const { col, row } = chrome1(opts);
      input.type(sgr(65, col, row));
      expect(ofKind(port, "picker_scroll")).toEqual([]);
    }

    {
      const { input, port } = harness();
      const opts = { n: 15, viewport: 8, scrollOffset: 0 };
      seedPicker(port, opts);
      const { col, row } = chrome1(opts);
      input.type(sgr(65, col, row));
      expect(ofKind(port, "picker_scroll")).toEqual([{ kind: "picker_scroll", delta: 1 }]);
      input.type(sgr(64, col, row));
      expect(ofKind(port, "picker_scroll")).toEqual([{ kind: "picker_scroll", delta: 1 }]);
    }

    {
      const { input, port } = harness();
      const opts = { n: 15, viewport: 8, scrollOffset: 0 };
      seedPicker(port, opts);
      const { col, row } = chrome1(opts);
      input.type(sgr(64, col, row));
      expect(ofKind(port, "picker_scroll")).toEqual([]);
    }

    {
      const { input, output, port } = harness();
      const opts = { n: 15 };
      seedPicker(port, opts);
      const a = pickerBody1(opts, 0);
      const b = pickerBody1(opts, 3);
      input.type(sgr(0, a.col, a.row, false));
      input.type(sgr(32, b.col, b.row, false));
      input.type(sgr(0, b.col, b.row, true));
      expect({
        osc: osc52Payloads(output.writes.join("")),
        activate: ofKind(port, "picker_activate"),
      }).toEqual({ osc: [], activate: [] });
    }

    {
      const { input, output, port } = harness();
      const opts = { n: 15 };
      seedPicker(port, opts);
      const a = pickerBody1(opts, 1);
      input.type(sgr(0, a.col, a.row, false));
      input.type(sgr(32, 1, 1, false));
      input.type(sgr(0, 1, 1, true));
      expect({
        osc: osc52Payloads(output.writes.join("")),
        activate: ofKind(port, "picker_activate"),
      }).toEqual({ osc: [], activate: [] });
    }

    {
      const { input, output, port } = harness();
      const opts = { n: 15 };
      seedPicker(port, opts);
      const p = pickerBody1(opts, 0);
      input.type(sgr(0, 1, 1, false));
      input.type(sgr(32, 6, 1, false));
      input.type(sgr(32, p.col, p.row, false));
      input.type(sgr(0, p.col, p.row, true));
      expect({
        copied: osc52Payloads(output.writes.join("")).length > 0,
        activate: ofKind(port, "picker_activate"),
      }).toEqual({ copied: true, activate: [] });
    }

    {
      const { input, port } = harness();
      const opts = { n: 15, scrollOffset: 0 };
      seedPicker(port, opts);
      const a = pickerBody1(opts, 2);
      input.type(sgr(0, a.col, a.row, false));
      input.type(sgr(0, a.col, a.row, true));
      expect(ofKind(port, "picker_activate")).toEqual([{ kind: "picker_activate", key: "choice:2:row2" }]);
    }

    {
      const { output, port } = harness();
      seedPicker(port, { n: 15 });
      expect(motion1003(output.writes)).toEqual(["h"]);
      port.emit([{ kind: "box_set", boxId: COMPOSER_BOX, value: pickerComposer({ n: 15 }) }]);
      expect(motion1003(output.writes)).toEqual(["h"]);
      port.emit([{ kind: "box_set", boxId: COMPOSER_BOX, value: composer("") }]);
      expect(motion1003(output.writes)).toEqual(["h", "l"]);
      const afterOff = output.writes.join("").split("\x1b[?1003l").at(-1) ?? "";
      expect(afterOff.startsWith("\x1b[?1000h\x1b[?1002h\x1b[?1006h")).toBe(true);
    }

    {
      const { host, output, port } = harness();
      seedPicker(port, { n: 15 });
      expect(motion1003(output.writes)).toEqual(["h"]);
      host.stop();
      expect(motion1003(output.writes)).toEqual(["h", "l"]);
    }

    {
      const { input, output, port } = harness();
      seedPicker(port, { n: 15 });
      input.type(sgr(35, 1, 1, false));
      input.type(sgr(35, 6, 1, false));
      input.type(sgr(0, 6, 1, true));
      expect({
        osc: osc52Payloads(output.writes.join("")),
        activate: ofKind(port, "picker_activate"),
        scroll: ofKind(port, "picker_scroll"),
      }).toEqual({ osc: [], activate: [], scroll: [] });
    }
  } finally {
    for (const host of hosts) host.stop();
  }
});
