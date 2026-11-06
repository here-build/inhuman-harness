/**
 * Local golden compare — same stack as monorepo web visual tests
 * (pixelmatch + pngjs). UPDATE_SCREENSHOTS=1 rewrites baselines.
 *
 * Missing goldens FAIL unless update/UPDATE_SCREENSHOTS — never auto-mint.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";

import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

import type { Rect } from "./screenshot.js";

/**
 * Device-pixel corner radius masked by default.
 *
 * `screencapture -R` takes a rectangle, but the window inside it is rounded,
 * so the corner pixels are whatever the desktop happens to show. ~10pt of
 * macOS rounding at 2× ≈ 20px; 24 leaves margin for the antialiased edge and
 * over-masks harmlessly at 1×.
 */
export const DEFAULT_CORNER_RADIUS = 24;

export type MatchGoldenOpts = {
  /** Relative or absolute path to committed baseline PNG. */
  goldenPath: string;
  /** 0–1 fraction of differing pixels allowed (default 0.01 = 1%). */
  maxDiffRatio?: number;
  /** pixelmatch threshold 0–1 (default 0.1). */
  threshold?: number;
  /** Force rewrite golden (or set env UPDATE_SCREENSHOTS=1). */
  update?: boolean;
  /** Directory for --actual / --diff artifacts on failure. */
  artifactDir?: string;
  /** Rounded-corner mask radius in device px. 0 disables. */
  cornerRadius?: number;
  /** Extra device-px rectangles to exclude (clocks, titles, anything live). */
  ignoreRegions?: readonly Rect[];
};

export type MatchGoldenResult = {
  pass: boolean;
  diffPixels: number;
  /** Compared pixels — masked ones are excluded, so the ratio stays honest. */
  totalPixels: number;
  diffRatio: number;
  /** How many pixels the corner + ignore-region mask excluded. */
  maskedPixels: number;
  updated: boolean;
  actualPath?: string;
  diffPath?: string;
};

/**
 * Mark the four rounded-corner wedges: inside the capture rectangle, outside
 * the window's curve. Pixel centres beyond the radius are desktop, not us.
 */
function markRoundedCorners(mask: Uint8Array, width: number, height: number, radius: number): void {
  // Pull the cut 1.5px inward so the antialiased rim goes with the wallpaper.
  const lim = Math.max(0, radius - 1.5);
  const limSq = lim * lim;
  const span = Math.min(Math.ceil(radius), width, height);
  for (let dy = 0; dy < span; dy++) {
    for (let dx = 0; dx < span; dx++) {
      const ox = radius - (dx + 0.5);
      const oy = radius - (dy + 0.5);
      if (ox * ox + oy * oy <= limSq) continue;
      mask[dy * width + dx] = 1;
      mask[dy * width + (width - 1 - dx)] = 1;
      mask[(height - 1 - dy) * width + dx] = 1;
      mask[(height - 1 - dy) * width + (width - 1 - dx)] = 1;
    }
  }
}

function markRect(mask: Uint8Array, width: number, height: number, r: Rect): void {
  const x0 = Math.max(0, Math.floor(r.x));
  const y0 = Math.max(0, Math.floor(r.y));
  const x1 = Math.min(width, Math.ceil(r.x + r.width));
  const y1 = Math.min(height, Math.ceil(r.y + r.height));
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) mask[y * width + x] = 1;
  }
}

/** Flatten masked pixels to one colour in both images so they cannot differ. */
function applyMask(data: Buffer, mask: Uint8Array): void {
  for (const [i, bit] of mask.entries()) {
    if (!bit) continue;
    const o = i * 4;
    data[o] = 0;
    data[o + 1] = 0;
    data[o + 2] = 0;
    data[o + 3] = 255;
  }
}

function cropOrPad(src: PNG, w: number, h: number): Buffer {
  if (src.width === w && src.height === h) return src.data;
  const out = Buffer.alloc(w * h * 4);
  const copyW = Math.min(src.width, w);
  const copyH = Math.min(src.height, h);
  for (let y = 0; y < copyH; y++) {
    src.data.copy(out, y * w * 4, y * src.width * 4, y * src.width * 4 + copyW * 4);
  }
  return out;
}

export function matchGolden(actualPng: Buffer, opts: MatchGoldenOpts): MatchGoldenResult {
  const update = opts.update === true || process.env["UPDATE_SCREENSHOTS"] === "1";
  const threshold = opts.threshold ?? 0.1;
  const maxDiffRatio = opts.maxDiffRatio ?? 0.01;
  const goldenPath = opts.goldenPath;

  if (update) {
    // Baselines stay as-captured. Masking happens at compare time only, so
    // changing the radius later never costs a re-record.
    mkdirSync(dirname(goldenPath), { recursive: true });
    writeFileSync(goldenPath, actualPng);
    return {
      pass: true,
      diffPixels: 0,
      totalPixels: 0,
      diffRatio: 0,
      maskedPixels: 0,
      updated: true,
    };
  }

  if (!existsSync(goldenPath)) {
    // Self-fulfilling goldens are forbidden: missing baseline must fail unless
    // UPDATE_SCREENSHOTS=1 (or opts.update). Drop actual as an artifact so the
    // first record is one intentional re-run away.
    const art = opts.artifactDir ?? dirname(goldenPath);
    mkdirSync(art, { recursive: true });
    const base = goldenPath.replace(/\.png$/i, "");
    const actualPath = `${base}.actual.png`;
    writeFileSync(actualPath, actualPng);
    return {
      pass: false,
      diffPixels: 0,
      totalPixels: 0,
      diffRatio: 1,
      maskedPixels: 0,
      updated: false,
      actualPath,
    };
  }

  const baseline = readFileSync(goldenPath);
  const a = PNG.sync.read(actualPng);
  const b = PNG.sync.read(baseline);
  const width = Math.max(a.width, b.width);
  const height = Math.max(a.height, b.height);
  const diff = new PNG({ width, height });
  const aData = cropOrPad(a, width, height);
  const bData = cropOrPad(b, width, height);

  // A corner mask must never eat more than a corner: clamp to a quarter of the
  // shorter side so the four wedges cannot meet on small images.
  const cornerRadius = Math.min(opts.cornerRadius ?? DEFAULT_CORNER_RADIUS, Math.floor(Math.min(width, height) / 4));
  const ignoreRegions = opts.ignoreRegions ?? [];
  let maskedPixels = 0;
  if (cornerRadius > 0 || ignoreRegions.length > 0) {
    const mask = new Uint8Array(width * height);
    if (cornerRadius > 0) markRoundedCorners(mask, width, height, cornerRadius);
    for (const r of ignoreRegions) markRect(mask, width, height, r);
    applyMask(aData, mask);
    applyMask(bData, mask);
    for (let i = 0; i < mask.length; i++) if (mask[i]) maskedPixels++;
  }

  const diffPixels = pixelmatch(aData, bData, diff.data, width, height, {
    threshold,
  });
  const totalPixels = width * height - maskedPixels;
  const diffRatio = totalPixels === 0 ? 0 : diffPixels / totalPixels;
  const pass = diffRatio <= maxDiffRatio;

  let actualPath: string | undefined;
  let diffPath: string | undefined;
  if (!pass) {
    const art = opts.artifactDir ?? dirname(goldenPath);
    mkdirSync(art, { recursive: true });
    const base = goldenPath.replace(/\.png$/i, "");
    actualPath = `${base}.actual.png`;
    diffPath = `${base}.diff.png`;
    writeFileSync(actualPath, actualPng);
    writeFileSync(diffPath, PNG.sync.write(diff));
  }

  return {
    pass,
    diffPixels,
    totalPixels,
    diffRatio,
    maskedPixels,
    updated: false,
    actualPath,
    diffPath,
  };
}
