import { bootSyntax } from "@inhuman.tools/quickdraw/widgets";
import { expect, test } from "vitest";

import { createWorkCell } from "../paint-dom.js";
import { createPaintWidgetHost } from "../paint-widgets.js";

/**
 * A retained widget bakes shiki token colors into its subtree at expand
 * time and stamps it `paintReady`, so quickdraw's `expandWidgetPriors` skips
 * it on later frames. The only thing that can re-expand it is the widget's
 * own reaction noticing a change — which requires the ambient syntax state
 * it reads (polarity / warmth) to be MobX-observable. A polarity flip must
 * therefore reach the painted cells, or the diff keeps rendering the old
 * palette.
 */
function diffCell() {
  const cell = createWorkCell("ask");
  cell.setFace({
    name: "edit_file",
    object: "src/hello.ts",
    status: "",
    state: "ask",
    indent: false,
    split: false,
    receiptKind: "diff",
    receiptText: "",
    diffOld: 'export function greet() {\n  return "hello";\n}',
    diffNew: 'export function greet() {\n  return "hi, world";\n}',
    diffPath: "src/hello.ts",
  });
  return cell;
}

function tokenPalette(root: unknown): string[] {
  const out: string[] = [];
  const visit = (node: any): void => {
    if (node && typeof node === "object") {
      const fg = node.style?.fgRgb;
      if (fg !== undefined) out.push(`${fg.r},${fg.g},${fg.b}`);
      for (const child of node.children ?? []) visit(child);
      if (node.summary) visit(node.summary);
    }
  };
  visit(root);
  return out;
}

test("retained diff re-expands once the highlighter warms", async () => {
  // Cold first: widgets are built before bootSyntax resolves in production.
  // Must stay ahead of the polarity test below — the highlighter is module
  // global, so once it is warm it cannot go cold again.
  const host = createPaintWidgetHost({ requestPaint: () => undefined });
  const cell = diffCell();
  const cold = tokenPalette(host.widgetFor(cell).prepare(80).root);
  await bootSyntax("dark");
  const warm = tokenPalette(host.widgetFor(cell).prepare(80).root);
  expect({ coldPlain: cold.length === 0, warmHighlighted: warm.length > 0 }).toEqual({
    coldPlain: true,
    warmHighlighted: true,
  });
}, 60_000);

test("retained diff re-expands when highlighter polarity flips", async () => {
  await bootSyntax("dark");
  // Default syntax accessors (the observable ones) — overriding these with
  // constants would defeat the test exactly like it hid the bug.
  const host = createPaintWidgetHost({ requestPaint: () => undefined });
  const cell = diffCell();
  const dark = tokenPalette(host.widgetFor(cell).prepare(80).root);
  await bootSyntax("light");
  const light = tokenPalette(host.widgetFor(cell).prepare(80).root);
  expect({
    darkHasTokens: dark.length > 0,
    paletteFollowsPolarity: JSON.stringify(dark) !== JSON.stringify(light),
  }).toEqual({
    darkHasTokens: true,
    paletteFollowsPolarity: true,
  });
}, 60_000);
