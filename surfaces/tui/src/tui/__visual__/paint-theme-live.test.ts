import { createPaintLocal } from "@inhuman.tools/quickdraw/runtime";
import { bootSyntax } from "@inhuman.tools/quickdraw/widgets";
import { runInAction } from "mobx";
import { expect, test } from "vitest";

import { createPaintRoot, createStack, createWorkCell, type WorkCellPaintInstance } from "../paint-dom.js";
import { createHarnessPaintSource } from "../paint-source.js";
import { createPaintReader, createPaintWriter, type PaintDownMessage } from "../paint-transport.js";
import { paletteOf } from "./palette-sample.js";

/**
 * Reproduction for the reported symptom: a LIVE theme change (OSC 11 ground
 * flip, e.g. dark → light) must reach the painted diff. Widget-level
 * re-expand is covered by paint-theme-diff; this drives the whole
 * paint-source → prepared → retained widget path the host ticks.
 */
function diffTree(): { root: ReturnType<typeof createPaintRoot>; cell: WorkCellPaintInstance } {
  const root = createPaintRoot();
  const stack = createStack();
  const cell = createWorkCell("tool");
  cell.setFace({
    name: "edit_file",
    object: "src/hello.ts",
    status: "",
    state: "ok",
    indent: false,
    split: false,
    receiptKind: "diff",
    receiptText: "",
    diffOld: 'export function greet() {\n  return "hello";\n}',
    diffNew: 'export function greet() {\n  return "hi, world";\n}',
    diffPath: "src/hello.ts",
  });
  stack.appendChild(cell);
  root.appendChild(stack);
  return { root, cell };
}

function bind(cols = 80, rows = 24) {
  const reader = createPaintReader();
  const source = createHarnessPaintSource({ reader });
  const local = createPaintLocal(cols, rows);
  runInAction(() => {
    local.tapeExpanded = true;
  });
  source.bind({ requestPaint: () => undefined }, local);
  const apply = (messages: readonly PaintDownMessage[]): void => {
    for (const message of messages) {
      reader.apply(message);
      source.noteReplica(message.kind);
    }
  };
  const prepare = () => {
    runInAction(() => {
      local.cols = cols;
      local.rows = rows;
    });
    return source.prepare();
  };
  return { source, local, apply, prepare };
}

/** Attach a writer so the reader sees a real paint_init, then flush. */
function publish(root: ReturnType<typeof createPaintRoot>): readonly PaintDownMessage[] {
  const out: PaintDownMessage[] = [];
  const writer = createPaintWriter("e1", (message) => out.push(message));
  writer.attach(root);
  writer.close("flush");
  return out;
}

test("live ground flip recolors the diff through the paint source", async () => {
  await bootSyntax("dark");
  const tree = diffTree();
  const harness = bind();
  harness.apply(publish(tree.root));

  const dark = paletteOf(harness.prepare().root);
  expect(dark.size, "dark diff must have token color").toBeGreaterThan(0);

  // Simulate the host theme reaction: flip ambient polarity the way
  // Renderer.#applyThemeSink does on a ground change.
  await bootSyntax("light");
  const light = paletteOf(harness.prepare().root);

  expect(
    { dark: [...dark].sort().join("|"), light: [...light].sort().join("|") },
    "diff palette must follow the live polarity flip",
  ).not.toEqual({ dark: [...dark].sort().join("|"), light: [...dark].sort().join("|") });
});
