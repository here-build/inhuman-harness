import { expect, test } from "vitest";

import { createTtySession, mouseAnyMotionBytes, mousePointerBytes } from "../tty.js";

function modes(bytes: string): { on: number[]; off: number[] } {
  const on: number[] = [];
  const off: number[] = [];
  for (const m of bytes.matchAll(/\x1b\[\?(\d+)([hl])/g)) {
    (m[2] === "h" ? on : off).push(Number(m[1]));
  }
  if (!on.includes(1003) && !off.includes(1003)) off.push(1003);
  return { on, off };
}

function teardown(bytes: string): {
  last: string;
  always2026: boolean;
  hasCsiR: boolean;
  autowrapOn: boolean;
  cursorOn: boolean;
  cellMotionOff: boolean;
  syncBeforeAlt: boolean;
} {
  return {
    last: bytes.endsWith("\x1b[?1049l") ? "1049l" : "other",
    always2026: bytes.includes("\x1b[?2026l"),
    hasCsiR: bytes.includes("\x1b[r"),
    autowrapOn: bytes.includes("\x1b[?7h"),
    cursorOn: bytes.includes("\x1b[?25h"),
    cellMotionOff: bytes.includes("\x1b[?1002l"),
    syncBeforeAlt: bytes.indexOf("\x1b[?2026l") < bytes.indexOf("\x1b[?1049l"),
  };
}

test("TTY enter/exit", () => {
  const sync = createTtySession({ sync2026: true });
  const enter = sync.enterBytes();
  expect(enter).toEqual(
    [
      "\x1b[?1049h",
      "\x1b[2J",
      "\x1b[H",
      "\x1b[?25l",
      "\x1b[?7l",
      "\x1b[?2026h",
      // iTerm resets kitty flags when modifyOtherKeys is enabled.
      "\x1b[>4;2m",
      "\x1b[>31u",
      "\x1b[=31;1u",
      "\x1b[?2004h",
      "\x1b[?1004h",
      "\x1b[?1000h",
      "\x1b[?1002h",
      "\x1b[?1006h",
      "\x1b[?1007h",
    ].join(""),
  );
  expect(modes(enter)).toEqual({
    on: [1049, 2026, 2004, 1004, 1000, 1002, 1006, 1007],
    off: [25, 7, 1003],
  });
  expect(modes(createTtySession().enterBytes())).toEqual({
    on: [1049, 2004, 1004, 1000, 1002, 1006, 1007],
    off: [25, 7, 1003],
  });

  const exit = {
    sync: teardown(sync.exitBytes()),
    unsynced: teardown(createTtySession({ sync2026: false }).exitBytes()),
  };
  expect(exit.sync).toMatchObject({
    last: "1049l",
    always2026: true,
    hasCsiR: true,
    autowrapOn: true,
    cursorOn: true,
    cellMotionOff: true,
    syncBeforeAlt: true,
  });
  expect(exit.unsynced).toMatchObject({
    last: "1049l",
    always2026: true,
    hasCsiR: true,
    autowrapOn: true,
    cursorOn: true,
  });

  expect(mouseAnyMotionBytes(true)).toEqual("\x1b[?1003h");
  expect(mouseAnyMotionBytes(false)).toEqual("\x1b[?1003l\x1b[?1000h\x1b[?1002h\x1b[?1006h");
  expect(mousePointerBytes("pointer")).toEqual("\x1b]22;pointer\x07");
  expect(mousePointerBytes("default")).toEqual("\x1b]22;default\x07");
  expect(sync.exitBytes().includes("\x1b]22;default\x07")).toBe(true);
});
