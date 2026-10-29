/**
 * Review raster of a present dump.
 * Fills and inks are the resolved cell colors, the same ones `bufferToPng` draws.
 * A dump without them falls back to `resolveStyle` on role and prominence.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createBuffer, put } from "@inhuman.tools/quickdraw/buffer";
import { FgP } from "@inhuman.tools/quickdraw/lexicon";
import { defaultTheme, resolveStyle } from "@inhuman.tools/quickdraw/theme";

import type { Dump, Ink, Run } from "./dump.js";

type Rgb = { r: number; g: number; b: number };

type PngRaster = {
  bufferToPng(buf: ReturnType<typeof createBuffer>, groundHex: string): Buffer;
};

const presentDir = dirname(fileURLToPath(import.meta.url));

const INK_RGB: Record<Ink, Rgb> = {
  primary: { r: 255, g: 255, b: 255 },
  secondary: { r: 0xbb, g: 0xbb, b: 0xbb },
  rising: { r: 0x88, g: 0xcc, b: 0xff },
  ghost: { r: 0x66, g: 0x66, b: 0x66 },
  whisper: { r: 0x44, g: 0x44, b: 0x44 },
};

const INK_PROMINENCE: Record<Ink, number> = {
  primary: FgP.primary,
  secondary: FgP.secondary,
  rising: FgP.rising,
  ghost: FgP.ghost,
  whisper: FgP.whisper,
};

/** Rewind content fade. Used only when the dump has no resolved ink. */
const DIM_REGION = 0.45;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rgbOf(hex: string): Rgb {
  const n = Number.parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function fgOf(run: Run): Rgb {
  const solved = resolveStyle(
    { role: run.role, prominence: INK_PROMINENCE[run.ink], regionProminence: run.dim ? DIM_REGION : 1 },
    { theme: defaultTheme, depth: "truecolor" },
  );
  return solved.fgRgb ?? INK_RGB[run.ink];
}

function isPngRaster(value: unknown): value is PngRaster {
  return isRecord(value) && typeof value.bufferToPng === "function";
}

let rasterPromise: Promise<PngRaster> | undefined;

function loadRaster(): Promise<PngRaster> {
  rasterPromise ??= importRaster();
  return rasterPromise;
}

async function importRaster(): Promise<PngRaster> {
  // bufferToPng is not a package export. The built module walks up to fonts/.
  const file = join(presentDir, "../../../../quickdraw/dist/runtime/screenshot.js");
  const loaded: unknown = await import(pathToFileURL(file).href);
  if (!isPngRaster(loaded)) throw new Error(`quickdraw bufferToPng missing at ${file}`);
  return loaded;
}

export async function writeRunsPng(file: string, dump: Dump, cols: number, rows: number): Promise<void> {
  const raster = await loadRaster();
  const buf = createBuffer(cols, rows);
  for (const fill of dump.fills) {
    put(buf, fill.x, fill.y, " ".repeat(fill.w), { bgRgb: rgbOf(fill.bg) });
  }
  if (dump.inks.length > 0) {
    for (const ink of dump.inks) {
      put(buf, ink.x, ink.y, ink.text, { fgRgb: rgbOf(ink.fg) });
    }
  } else {
    for (const run of dump.runs) {
      put(buf, run.x, run.y, run.text, { fgRgb: fgOf(run) });
    }
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, raster.bufferToPng(buf, defaultTheme.groundHex));
}
