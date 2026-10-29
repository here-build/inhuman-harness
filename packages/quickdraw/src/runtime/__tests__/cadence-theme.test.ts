/**
 * End-to-end dynamic theme change: a live OSC 11 ground reply must reach the
 * painted diff. The host's theme reaction flips ambient shiki polarity and
 * drops the cached Frame; a retained paint source (like the harness widget
 * host) must then re-expand its baked-token subtree.
 */
import { expect, test } from "vitest";

import { BLOCK_BOX, composer, FakeBoxCadencePort, FakeTtyInput, FakeTtyOutput, structure } from "./_helpers.js";
import { attuneTheme, type LayoutNode, type ThemeBinding } from "../../layout/index.js";
import { createPaintLocal, type PreparedPaint, type RetainedPaintSource } from "../../runtime/paint_source.js";
import { Renderer } from "../../runtime/renderer.js";
import { Diff } from "../../widgets/diff.js";
import { expandWidgetPriors } from "../../widgets/expand.js";
import { syntaxPolarity } from "../../widgets/index.js";
import { bootSyntax } from "../../widgets/syntax-boot.js";

const GEOMETRY = { cols: 60, rows: 12 };
const syncSchedule = (fn: () => void): void => fn();

const OLD = 'export function greet() {\n  return "hello";\n}';
const NEW = 'export function greet() {\n  return "hi, world";\n}';

/** Stands in for the harness WorkCellWidget: bakes tokens at expand time. */
class DiffPaintSource implements RetainedPaintSource {
  readonly local = createPaintLocal(GEOMETRY.cols, GEOMETRY.rows);

  bind(): Disposable {
    return { [Symbol.dispose]: () => undefined };
  }

  get snapshot(): PreparedPaint {
    return this.prepare();
  }

  prepare(): PreparedPaint {
    const prior: LayoutNode = {
      type: "flex",
      key: "root",
      style: { direction: "column" },
      children: [Diff({ old: OLD, new: NEW, path: "src/hello.ts", width: GEOMETRY.cols, key: "diff" }), composer("")],
    };
    // polarity is read here so MobX tracks this computed; a flip invalidates.
    const polarity = syntaxPolarity();
    const expanded = expandWidgetPriors(prior, { width: GEOMETRY.cols });
    return {
      root: expanded,
      composer: { draft: "", cursor: 0, mark: null, interactive: true },
      birthSites: [],
      progressSites: [],
      picker: null,
      contentIdentity: polarity,
    };
  }
}

function paintedColors(host: Renderer, output: FakeTtyOutput): Set<string> {
  host.tick();
  const colors = new Set<string>();
  for (const chunk of output.writes) {
    for (const match of chunk.matchAll(/(?:\[|;)(38|48);2;(\d+);(\d+);(\d+)(?=;|m)/gu)) {
      colors.add(`${match[1]!};${match[2]!},${match[3]!},${match[4]!}`);
    }
  }
  output.writes.length = 0;
  return colors;
}

test("OSC 11 ground flip recolors a retained diff", async () => {
  await bootSyntax("dark");
  const port = new FakeBoxCadencePort();
  const input = new FakeTtyInput();
  const output = new FakeTtyOutput(GEOMETRY.cols, GEOMETRY.rows);
  const source = new DiffPaintSource();
  const theme: ThemeBinding = attuneTheme({ depth: "truecolor", ground: 0.18 });
  const host = new Renderer({
    port,
    input,
    output,
    schedule: syncSchedule,
    theme,
    paintSource: source,
    paintLocal: source.local,
  });
  host.start();
  port.emit([structure(1, [{ key: "block", boxId: BLOCK_BOX }])]);

  const dark = paintedColors(host, output);
  expect(dark.size, "dark frame paints colors").toBeGreaterThan(0);

  // Live theme change: terminal answers OSC 11 with a LIGHT ground.
  input.type("\u001B]11;rgb:f5f5/f5f5/f5f5\u0007");
  const light = paintedColors(host, output);

  expect(syntaxPolarity(), "host ground flipped to light").toBe("light");
  expect(
    { dark: [...dark].sort().join("|"), light: [...light].sort().join("|") },
    "painted colors must follow the live ground flip",
  ).not.toEqual({ dark: [...dark].sort().join("|"), light: [...dark].sort().join("|") });
  host.stop();
});
