import { FgP } from "@inhuman.tools/quickdraw/lexicon";
import {
  apparentLightness,
  ANSI16_ROLE,
  buildTheme,
  resolveStyle,
  rgbToOklch,
  seedHueRgb,
} from "@inhuman.tools/quickdraw/theme";
import { expect, test } from "vitest";

import { VtText } from "../vt-paint.js";

const ESC = "\u001b";
const JND = 0.074;
const HUE_FLOOR = 15;

function hueDelta(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

function alOf(rgb: { r: number; g: number; b: number }): number {
  const { l, c, h } = rgbToOklch(rgb.r, rgb.g, rgb.b);
  return apparentLightness(l, c, h);
}

function collect(
  node: unknown,
): { content: string; fgRgb?: { r: number; g: number; b: number }; role?: string; prominence?: number }[] {
  const out: { content: string; fgRgb?: { r: number; g: number; b: number }; role?: string; prominence?: number }[] =
    [];
  const walk = (cur: unknown): void => {
    if (typeof cur !== "object" || cur === null) return;
    const rec = cur as {
      content?: unknown;
      style?: { fgRgb?: { r: number; g: number; b: number }; role?: string; prominence?: number };
      children?: unknown[];
    };
    if (typeof rec.content === "string") {
      out.push({
        content: rec.content,
        fgRgb: rec.style?.fgRgb,
        role: rec.style?.role,
        prominence: rec.style?.prominence,
      });
    }
    if (Array.isArray(rec.children)) {
      for (const child of rec.children) walk(child);
    }
  };
  walk(node);
  return out;
}

test("VtText wraps at the column and keeps ANSI on the split", () => {
  const node = VtText(`${ESC}[31m${"ab".repeat(10)}${ESC}[0m`, {
    key: "body",
    width: 8,
    style: { role: "foreground", prominence: FgP.ghost },
  });
  const kids = node.type === "flex" ? (node.children ?? []) : [];
  const rows = kids.map((child) =>
    child.type === "flex"
      ? (child.children ?? []).map((span) => (span.type === "text" ? span.content : "")).join("")
      : "",
  );
  expect({
    rows: rows.length > 1,
    widths: rows.every((row) => [...row].length <= 8),
    ink: kids.some(
      (child) =>
        child.type === "flex" &&
        (child.children ?? []).some((span) => span.type === "text" && span.style?.fgRgb !== undefined),
    ),
  }).toEqual({ rows: true, widths: true, ink: true });
});

test("VtText maps ANSI slots onto theme hue/chroma and recasts AL onto the voice", () => {
  const red = `${ESC}[31mred${ESC}[0m plain`;
  const node = VtText(red, {
    key: "body",
    width: 40,
    style: { role: "foreground", prominence: FgP.ghost },
  });
  const spans = collect(node);
  const painted = spans.find((span) => span.content === "red");
  const theme = buildTheme({ ground: 0.2 });
  const resolved = resolveStyle(
    { role: "foreground", prominence: FgP.ghost, fgRgb: painted?.fgRgb },
    { theme, depth: "truecolor" },
  );
  const voice = resolveStyle({ role: "foreground", prominence: FgP.ghost }, { theme, depth: "truecolor" });
  const errorSeed = seedHueRgb("error");
  const errorHue = rgbToOklch(errorSeed.r, errorSeed.g, errorSeed.b);
  const tok = rgbToOklch(painted!.fgRgb!.r, painted!.fgRgb!.g, painted!.fgRgb!.b);
  expect({
    leftover: spans.some((span) => span.content.includes("[") || span.content.includes(ESC)),
    slot: ANSI16_ROLE[1],
    role: painted?.role,
    prominence: painted?.prominence,
    hue: hueDelta(tok.h, errorHue.h) < HUE_FLOOR,
    al: Math.abs(alOf(resolved.fgRgb!) - alOf(voice.fgRgb!)) < JND,
    joined: spans.map((span) => span.content).join(""),
  }).toEqual({
    leftover: false,
    slot: "error",
    role: "foreground",
    prominence: FgP.ghost,
    hue: true,
    al: true,
    joined: "red plain",
  });
});
