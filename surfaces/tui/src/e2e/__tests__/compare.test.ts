import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PNG } from "pngjs";
import { expect, test } from "vitest";

import { matchGolden } from "../compare.js";

function solidPng(w: number, h: number, rgba: [number, number, number, number]): Buffer {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h; i++) {
    png.data[i * 4] = rgba[0];
    png.data[i * 4 + 1] = rgba[1];
    png.data[i * 4 + 2] = rgba[2];
    png.data[i * 4 + 3] = rgba[3];
  }
  return PNG.sync.write(png);
}

/** Solid image with one pixel repainted — stands in for wallpaper bleed. */
function pngWithPixel(
  w: number,
  h: number,
  base: [number, number, number, number],
  at: { x: number; y: number },
  rgba: [number, number, number, number],
): Buffer {
  const png = PNG.sync.read(solidPng(w, h, base));
  const o = (at.y * w + at.x) * 4;
  png.data[o] = rgba[0];
  png.data[o + 1] = rgba[1];
  png.data[o + 2] = rgba[2];
  png.data[o + 3] = rgba[3];
  return PNG.sync.write(png);
}

test("matchGolden: missing, update, pixel differ, corner mask, inside curve, ignoreRegions", () => {
  const dir = mkdtempSync(join(tmpdir(), "te2e-"));
  try {
    const missingPath = join(dir, "missing.png");
    const missing = matchGolden(solidPng(4, 4, [10, 20, 30, 255]), {
      goldenPath: missingPath,
    });
    expect({
      pass: missing.pass,
      updated: missing.updated,
      actual: Boolean(missing.actualPath),
      exists: existsSync(missingPath),
    }).toEqual({ pass: false, updated: false, actual: true, exists: false });

    const writePath = join(dir, "write.png");
    const wrote = matchGolden(solidPng(4, 4, [10, 20, 30, 255]), {
      goldenPath: writePath,
      update: true,
    });
    expect({
      pass: wrote.pass,
      updated: wrote.updated,
      bytes: readFileSync(writePath).length,
    }).toMatchObject({ pass: true, updated: true });
    expect(readFileSync(writePath).length).toBeGreaterThan(0);

    const differPath = join(dir, "differ.png");
    matchGolden(solidPng(8, 8, [0, 0, 0, 255]), {
      goldenPath: differPath,
      update: true,
    });
    const differ = matchGolden(solidPng(8, 8, [255, 0, 0, 255]), {
      goldenPath: differPath,
      maxDiffRatio: 0.001,
    });
    expect({
      pass: differ.pass,
      actual: Boolean(differ.actualPath),
      diff: Boolean(differ.diffPath),
    }).toEqual({ pass: false, actual: true, diff: true });
    expect(differ.diffRatio).toBeGreaterThan(0.5);

    const cornerPath = join(dir, "corner.png");
    matchGolden(solidPng(80, 80, [0, 0, 0, 255]), {
      goldenPath: cornerPath,
      update: true,
    });
    // (0,0) is outside the window's curve — desktop, not our output.
    const corner = matchGolden(pngWithPixel(80, 80, [0, 0, 0, 255], { x: 0, y: 0 }, [255, 0, 255, 255]), {
      goldenPath: cornerPath,
      maxDiffRatio: 0,
    });
    expect({
      pass: corner.pass,
      diffPixels: corner.diffPixels,
      totalPixels: corner.totalPixels,
    }).toEqual({
      pass: true,
      diffPixels: 0,
      totalPixels: 80 * 80 - corner.maskedPixels,
    });
    expect(corner.maskedPixels).toBeGreaterThan(0);

    const inside = matchGolden(pngWithPixel(80, 80, [0, 0, 0, 255], { x: 40, y: 40 }, [255, 0, 255, 255]), {
      goldenPath: cornerPath,
      maxDiffRatio: 0,
    });
    expect({ pass: inside.pass, diffPixels: inside.diffPixels }).toEqual({
      pass: false,
      diffPixels: 1,
    });

    const changed = pngWithPixel(80, 80, [0, 0, 0, 255], { x: 40, y: 40 }, [255, 0, 255, 255]);
    expect({
      unmasked: matchGolden(changed, { goldenPath: cornerPath, maxDiffRatio: 0 }).pass,
      ignored: matchGolden(changed, {
        goldenPath: cornerPath,
        maxDiffRatio: 0,
        ignoreRegions: [{ x: 38, y: 38, width: 4, height: 4 }],
      }).pass,
    }).toEqual({ unmasked: false, ignored: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
