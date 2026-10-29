/* eslint-disable security/detect-non-literal-fs-filename, security/detect-non-literal-regexp -- the stylesheet beside this package */
/**
 * The color tokens in `styles.css`, held to WCAG 2.2 AA in both schemes:
 * 4.5:1 for text on every surface it sits on, 3:1 for a control's edge and a
 * status glyph. Hover and selection are ink laid over a surface, so they are
 * checked composited over each one.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const css = readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8");

type Rgb = readonly [number, number, number];
type Lab = readonly [number, number, number];
type Scheme = {
  readonly lab: ReadonlyMap<string, Lab>;
  readonly overlay: ReadonlyMap<string, number>;
};

/** The `:root` token block: each color a `light-dark(oklch(…), oklch(…))` pair. */
const rootBlock = ((): string => {
  const open = css.indexOf("{", css.search(/^:root\s*\{/m));
  return css.slice(open + 1, css.indexOf("\n}", open));
})();

function scheme(side: 0 | 1): Scheme {
  const lab = new Map<string, Lab>();
  const overlay = new Map<string, number>();
  const oklch = String.raw`oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)`;
  for (const match of rootBlock.matchAll(new RegExp(String.raw`--([\w-]+):\s*light-dark\(${oklch}, ${oklch}\)`, "g"))) {
    const [l, c, h] = match.slice(2 + side * 3, 5 + side * 3).map(Number) as [number, number, number];
    const rad = (h * Math.PI) / 180;
    lab.set(match[1]!, [l, c * Math.cos(rad), c * Math.sin(rad)]);
  }
  for (const [, name, percent] of rootBlock.matchAll(
    /--([\w-]+):\s*color-mix\(in oklab, var\(--ink\) ([\d.]+)%, transparent\)/g,
  )) {
    overlay.set(name!, Number(percent) / 100);
  }
  return { lab, overlay };
}

/** Gamma-encoded sRGB in [0, 1], clamped to the gamut the way a browser paints it. */
function srgb([l, a, b]: Lab): Rgb {
  const [x, y, z] = [
    l + 0.3963377774 * a + 0.2158037573 * b,
    l - 0.1055613458 * a - 0.0638541728 * b,
    l - 0.0894841775 * a - 1.291485548 * b,
  ].map((v) => v ** 3) as [number, number, number];
  const encode = (v: number): number => {
    const k = Math.min(1, Math.max(0, v));
    return k <= 0.0031308 ? 12.92 * k : 1.055 * k ** (1 / 2.4) - 0.055;
  };
  return [
    encode(4.0767416621 * x - 3.3077115913 * y + 0.2309699292 * z),
    encode(-1.2684380046 * x + 2.6097574011 * y - 0.3413193965 * z),
    encode(-0.0041960863 * x - 0.7034186147 * y + 1.707614701 * z),
  ];
}

function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)) as [
    number,
    number,
    number,
  ];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

function token(s: Scheme, name: string): Lab {
  const found = s.lab.get(name);
  if (found == null) throw new Error(`no token --${name}`);
  return found;
}

const color = (s: Scheme, name: string): Rgb => srgb(token(s, name));

/** Ink at an overlay's alpha, composited in sRGB over a surface, as the browser paints it. */
function laid(s: Scheme, overlay: string, under: string): Rgb {
  const alpha = s.overlay.get(overlay);
  if (alpha == null) throw new Error(`no overlay --${overlay}`);
  const base = color(s, under);
  const ink = color(s, "ink");
  return [0, 1, 2].map((i) => base[i]! * (1 - alpha) + ink[i]! * alpha) as unknown as Rgb;
}

const schemes = { light: scheme(0), dark: scheme(1) };

const SURFACES = ["canvas", "wash", "raised", "field"];

describe.each(Object.entries(schemes))("%s scheme", (_, s) => {
  it("reads every token as a pair", () => {
    expect([...s.lab.keys()]).toEqual(expect.arrayContaining(["canvas", "ink", "edge", "added-line", "removed-line"]));
    expect([...s.overlay.keys()]).toEqual(["hover", "selected"]);
  });

  it("keeps every text tier and status color AA on every surface", () => {
    const failing: string[] = [];
    for (const fg of ["ink", "muted", "subtle", "danger", "warning", "success", "working"]) {
      for (const bg of SURFACES) {
        const ratio = contrast(color(s, fg), color(s, bg));
        if (ratio < 4.5) failing.push(`${fg} on ${bg}: ${ratio.toFixed(2)}`);
      }
    }
    expect(failing).toEqual([]);
  });

  it("keeps ink and muted text AA on a hovered or selected row", () => {
    const failing: string[] = [];
    for (const fg of ["ink", "muted"]) {
      for (const overlay of ["hover", "selected"]) {
        for (const under of ["canvas", "wash", "raised"]) {
          const ratio = contrast(color(s, fg), laid(s, overlay, under));
          if (ratio < 4.5) failing.push(`${fg} on ${overlay} over ${under}: ${ratio.toFixed(2)}`);
        }
      }
    }
    expect(failing).toEqual([]);
  });

  it("bounds a control with 3:1 against everything around it", () => {
    for (const bg of ["canvas", "wash", "field"]) {
      expect(contrast(color(s, "edge"), color(s, bg)), `edge on ${bg}`).toBeGreaterThanOrEqual(3);
    }
    expect(contrast(color(s, "ink"), color(s, "canvas")), "focus ring").toBeGreaterThanOrEqual(3);
  });

  it("separates the tiers enough to read as three", () => {
    const on = (fg: string): number => contrast(color(s, fg), color(s, "canvas"));
    expect(on("ink") / on("muted")).toBeGreaterThan(1.5);
    expect(on("muted") / on("subtle")).toBeGreaterThan(1.2);
  });

  it("marks a changed line visibly but quietly, and keeps its text AA", () => {
    const canvas = token(s, "canvas");
    for (const line of ["added-line", "removed-line"]) {
      // OKLab's just-noticeable difference is about 0.02: the edge reads at a glance, never as a fill.
      const delta = Math.hypot(...token(s, line).map((v, i) => v - canvas[i]!));
      expect(delta, line).toBeGreaterThanOrEqual(0.04);
      expect(delta, line).toBeLessThanOrEqual(0.1);
      for (const fg of ["ink", "muted"]) {
        expect(contrast(color(s, fg), color(s, line)), `${fg} on ${line}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});

describe("dark elevation", () => {
  it("steps each surface past the lightness JND", () => {
    // OKLCH L is perceptual, so the step is read off the token directly.
    const l = (name: string): number => token(schemes.dark, name)[0];
    expect(l("wash") - l("canvas")).toBeGreaterThanOrEqual(0.04);
    expect(l("raised") - l("wash")).toBeGreaterThanOrEqual(0.04);
  });
});
