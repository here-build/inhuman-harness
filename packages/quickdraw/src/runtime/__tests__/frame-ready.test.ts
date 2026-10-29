import { expect, test } from "vitest";

import { FgP } from "../../lexicon/index.js";
import { renderFrame } from "../frame.js";

test("paint-ready root skips mailbox substitute and echo overlay", () => {
  let getBoxCalls = 0;
  const root = {
    type: "text" as const,
    key: "retained",
    content: "READY",
    paintReady: true as const,
  };
  const { buffer } = renderFrame({
    snapshot: {
      tree: { root, boxes: { composer: 1 } },
      getBox: () => {
        getBoxCalls += 1;
        return { type: "text", content: "MAILBOX" };
      },
    },
    geometry: { cols: 20, rows: 3 },
    state: {
      nowMs: 0,
      echo: {
        boxId: 1,
        predicted: { draft: "pred", cursor: 4, mark: null },
        misaligned: false,
      },
      hostHotkeys: [{ key: "Ctrl+C", action: "exit" }],
    },
  });
  expect(getBoxCalls).toBe(0);
  let painted = "";
  for (let i = 0; i < buffer.cells.length; i++) painted += buffer.cells[i]?.ch ?? "";
  expect(painted).toContain("READY");
  expect(painted).not.toContain("MAILBOX");
  expect(painted).not.toContain("pred");
});

test("hostHotkeys reach chrome_frame inside a paintReady composer", () => {
  const frame = {
    type: "chrome_frame" as const,
    key: "composer:frame",
    width: 36,
    draft: "",
    paintReady: true as const,
  };
  const root = {
    type: "box" as const,
    key: "rim",
    paintReady: true as const,
    children: [frame],
  };
  const { buffer } = renderFrame({
    snapshot: { tree: { root, boxes: {} }, getBox: () => undefined },
    geometry: { cols: 40, rows: 4 },
    state: {
      nowMs: 0,
      echo: { boxId: null, predicted: null, misaligned: false },
      hostHotkeys: [{ key: "Ctrl+C", action: "exit" }],
    },
  });
  let painted = "";
  for (let i = 0; i < buffer.cells.length; i++) painted += buffer.cells[i]?.ch ?? "";
  expect(painted).toContain("⌃ C: exit");
});

test("agents hover restyles session rows entirely in the render layer", () => {
  const root = {
    type: "flex" as const,
    key: "agents:body",
    paintReady: true as const,
    style: { direction: "column" as const },
    children: [
      {
        type: "text" as const,
        key: "session:a:name",
        content: "Alpha",
        style: { role: "foreground", prominence: FgP.primary },
      },
      {
        type: "text" as const,
        key: "session:b:name",
        content: "Beta",
        style: { role: "foreground", prominence: FgP.rising },
      },
    ],
  };
  const { buffer } = renderFrame({
    snapshot: { tree: { root, boxes: {} }, getBox: () => undefined },
    geometry: { cols: 20, rows: 3 },
    state: {
      nowMs: 0,
      echo: { boxId: null, predicted: null, misaligned: false },
      agentsChrome: { hoverKey: "session:b" },
    },
  });
  const alpha = buffer.cells.find((cell) => cell.ch === "A");
  const beta = buffer.cells.find((cell) => cell.ch === "B");
  expect({ alpha: alpha?.style.prominence, beta: beta?.style.prominence }).toEqual({
    alpha: FgP.rising,
    beta: FgP.primary,
  });
});
