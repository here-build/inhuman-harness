/**
 * fx stories must materialize real shader fields, not the null-field wash.
 *
 * Guards the registration seam: `materializeBgFx` is a consumer — without
 * `registerShadertoyCatalog` every sample silently resolves to
 * BGFX_NULL_FIELD and the story "renders" a flat rectangle. Loud-skips when
 * headless-gl is unavailable (native dep; minimal CI containers).
 */
import { expect, test } from "vitest";

import type { Buffer as CellBuffer } from "../../buffer/index.js";
import {
  hasBgFxShader,
  materializeBgFx,
  registerShadertoyCatalog,
  shadertoyGlAvailable,
  unregisterShadertoyCatalog,
} from "../../internals/bgfx/index.js";
import { getStory } from "../catalog.js";
import { paintNode } from "../render.js";

const glReady = shadertoyGlAvailable();
if (!glReady) {
  console.warn("[fx-materialize] headless-gl unavailable — suite skipped");
}

const COLS = 40;
const ROWS = 12;

function paintFxStory(tick: number): CellBuffer {
  const story = getStory("fx-gradient");
  expect(story).toBeDefined();
  const node = story!.build({ cols: COLS, rows: ROWS, tick, sample: 0 });
  const buf = paintNode(node, COLS, ROWS);
  materializeBgFx(buf, tick);
  return buf;
}

function bgSignature(buf: CellBuffer): string[] {
  return buf.cells.map((c) => {
    const rgb = (c.style as { bgRgb?: { r: number; g: number; b: number } }).bgRgb;
    return rgb ? `${rgb.r},${rgb.g},${rgb.b}` : "none";
  });
}

test.skipIf(!glReady)("fx story materializes a real gradient field", async ({ skip }) => {
  const r = await registerShadertoyCatalog({ worker: false });
  try {
    // shadertoyGlAvailable is resolve-only; native bindings can still fail to load.
    if (!r.ids.includes("gradient") || !hasBgFxShader("gradient")) {
      console.warn("[fx-materialize] headless-gl unavailable — suite skipped");
      skip();
      return;
    }

    expect({
      registered: r.ids.includes("gradient"),
      has: hasBgFxShader("gradient"),
    }).toEqual({ registered: true, has: true });

    const t0 = bgSignature(paintFxStory(0));
    const shaded = t0.filter((s) => s !== "none");
    expect(new Set(shaded).size).toBeGreaterThan(1);
    expect(bgSignature(paintFxStory(5))).not.toEqual(t0);
  } finally {
    unregisterShadertoyCatalog();
  }
});
