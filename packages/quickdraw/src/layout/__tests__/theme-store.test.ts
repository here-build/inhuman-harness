import { autorun } from "mobx";
import { expect, test } from "vitest";

import { BgP, FgP, type Rgb } from "../../lexicon/index.js";
import { apparentLightness, rgbToOklch, resolveStyle } from "../../theme/index.js";
import { ThemeStore } from "../theme_store.js";

function alOfRgb(rgb: Rgb): number {
  const o = rgbToOklch(rgb.r, rgb.g, rgb.b);
  return apparentLightness(o.l, o.c, o.h);
}

test("attune dark→light flips wash prominence away from ground", () => {
  const store = new ThemeStore({ ground: 0.2, depth: "truecolor" });
  const wash = { bgRole: "diff_add" as const, bgProminence: BgP.panel as number };
  const dark = resolveStyle(wash, { theme: store.theme, depth: "truecolor" });
  let ticks = 0;
  const stop = autorun(() => {
    void store.theme.ground;
    ticks += 1;
  });
  store.attune({ ground: 0.85 });
  const light = resolveStyle(wash, { theme: store.theme, depth: "truecolor" });
  stop();
  expect({
    darkAbove: alOfRgb(dark.bgRgb!) > 0.2,
    lightBelow: alOfRgb(light.bgRgb!) < 0.85,
    notified: ticks >= 2,
  }).toEqual({
    darkAbove: true,
    lightBelow: true,
    notified: true,
  });
});

test("omnibox progress fuse steers away from ground on both polarities", () => {
  const fused = {
    role: "foreground" as const,
    prominence: 0,
    fuseRole: "foreground" as const,
    fuseProminence: FgP.ghost as number,
  };
  const loud = {
    role: "foreground" as const,
    prominence: 1,
    fuseRole: "foreground" as const,
    fuseProminence: FgP.ghost as number,
  };
  const store = new ThemeStore({ ground: 0.2, depth: "truecolor" });
  const dark = {
    fused: alOfRgb(resolveStyle(fused, { theme: store.theme, depth: "truecolor" }).fgRgb!),
    loud: alOfRgb(resolveStyle(loud, { theme: store.theme, depth: "truecolor" }).fgRgb!),
  };
  store.attune({ ground: 0.85 });
  const light = {
    fused: alOfRgb(resolveStyle(fused, { theme: store.theme, depth: "truecolor" }).fgRgb!),
    loud: alOfRgb(resolveStyle(loud, { theme: store.theme, depth: "truecolor" }).fgRgb!),
  };
  expect({
    darkLoudAbove: dark.loud > dark.fused,
    lightLoudBelow: light.loud < light.fused,
  }).toEqual({
    darkLoudAbove: true,
    lightLoudBelow: true,
  });
});

test("attune same ground is a no-op", () => {
  const store = new ThemeStore({ ground: 0.2, depth: "truecolor" });
  let ticks = 0;
  const stop = autorun(() => {
    void store.theme.ground;
    ticks += 1;
  });
  const before = ticks;
  store.attune({ ground: 0.2, depth: "truecolor" });
  stop();
  expect(ticks).toBe(before);
});
