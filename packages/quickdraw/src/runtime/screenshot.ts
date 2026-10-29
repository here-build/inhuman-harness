/**
 * Cell buffer → PNG. No TTY, no computer-use. Truecolor cells plus a
 * bundled mono font, rastered by resvg. Goldens are the product look.
 */
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Resvg } from "@resvg/resvg-js";

import type { Buffer as CellBuffer, Style } from "../buffer/index.js";
import type { Rgb } from "../lexicon/color.js";

/** Device pixels per cell. Integer so box-drawing tiles. */
export const CELL_W = 10;
export const CELL_H = 20;
const FONT_SIZE = 16;
const FONT_MONO = "DejaVu Sans Mono";
const FONT_SANS = "DejaVu Sans";
/** Mono first; Sans covers Braille (spinner ⠋) which Mono lacks. */
const FONT_FAMILY = `${FONT_MONO}, ${FONT_SANS}`;

function familyFor(ch: string): string {
  const cp = ch.codePointAt(0) ?? 0;
  if (cp >= 0x28_00 && cp <= 0x28_ff) return FONT_SANS;
  return FONT_FAMILY;
}

function fontsDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    const hit = join(dir, "fonts");
    if (existsSync(join(hit, "DejaVuSansMono.ttf"))) return hit;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("screenshot font missing: fonts/DejaVuSansMono.ttf");
}

function fontFiles(): string[] {
  return readdirSync(fontsDir())
    .filter((name) => name.endsWith(".ttf"))
    .map((name) => join(fontsDir(), name));
}

function rgbHex(rgb: Rgb): string {
  const ch = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, "0");
  return `#${ch(rgb.r)}${ch(rgb.g)}${ch(rgb.b)}`;
}

function xml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function fgOf(style: Style): Rgb | undefined {
  return style.fgRgb;
}

function bgOf(style: Style): Rgb | undefined {
  return style.bgRgb;
}

/** SVG of the cell grid. Inspectable color oracle; PNG is the golden. */
export function bufferToSvg(buf: CellBuffer, groundHex: string): string {
  const width = buf.width * CELL_W;
  const height = buf.height * CELL_H;
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect width="100%" height="100%" fill="${groundHex}"/>`,
  ];
  for (let y = 0; y < buf.height; y += 1) {
    for (let x = 0; x < buf.width; x += 1) {
      const cell = buf.cells[y * buf.width + x];
      if (cell === undefined || cell.placeholder) continue;
      const px = x * CELL_W;
      const py = y * CELL_H;
      const bg = bgOf(cell.style);
      if (bg !== undefined) {
        parts.push(`<rect x="${px}" y="${py}" width="${CELL_W}" height="${CELL_H}" fill="${rgbHex(bg)}"/>`);
      }
      const ch = cell.ch;
      if (ch === "" || ch === " ") continue;
      const fg = fgOf(cell.style);
      const fill = fg === undefined ? groundHex : rgbHex(fg);
      const weight = cell.style.bold === true ? ' font-weight="700"' : "";
      const italic = cell.style.italic === true ? ' font-style="italic"' : "";
      const baseline = py + Math.round(CELL_H * 0.78);
      parts.push(
        `<text x="${px}" y="${baseline}" fill="${fill}" font-family="${familyFor(ch)}" font-size="${FONT_SIZE}"${weight}${italic}>${xml(ch)}</text>`,
      );
      if (cell.style.underline === true) {
        const uy = py + CELL_H - 3;
        parts.push(`<line x1="${px}" y1="${uy}" x2="${px + CELL_W}" y2="${uy}" stroke="${fill}" stroke-width="1"/>`);
      }
      if (cell.style.strike === true) {
        const sy = py + Math.round(CELL_H * 0.55);
        parts.push(`<line x1="${px}" y1="${sy}" x2="${px + CELL_W}" y2="${sy}" stroke="${fill}" stroke-width="1"/>`);
      }
    }
  }
  parts.push("</svg>");
  return parts.join("");
}

export function svgToPng(svg: string): Buffer {
  const resvg = new Resvg(svg, {
    fitTo: { mode: "original" },
    font: {
      fontFiles: fontFiles(),
      loadSystemFonts: false,
      defaultFontFamily: FONT_MONO,
    },
  });
  return Buffer.from(resvg.render().asPng());
}

export function bufferToPng(buf: CellBuffer, groundHex: string): Buffer {
  return svgToPng(bufferToSvg(buf, groundHex));
}
