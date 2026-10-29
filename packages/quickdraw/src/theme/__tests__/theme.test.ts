import { expect, test } from "vitest";

import { parseOsc11Payload } from "../../capabilities/index.js";
import { ALL_ROLES, BgP, FgP, type Rgb, type SemanticRole } from "../../lexicon/index.js";
import {
  ansi16Slot,
  ansi256ToRgb,
  apparentLightness,
  buildTheme,
  canvasPolarity,
  groundFromRgb,
  hexToOklch,
  hueFactor,
  nearestAnsi256,
  nearestAnsi256FromRgb,
  REFERENCE_GROUND,
  resolveStyle,
  rgbToOklch,
  selectionRecolorRgb,
  SELECTION_SHIFT,
  solve,
  solveLightness,
  tierTarget,
} from "../index.js";

const JND = 0.074;
const GROUNDS = [0.1, 0.2, 0.9] as const;
const HUE_FLOOR_DEG = 15;
const FG_LADDER = [
  ["whisper", FgP.whisper],
  ["ghost", FgP.ghost],
  ["rising", FgP.rising],
  ["secondary", FgP.secondary],
  ["primary", FgP.primary],
] as const;

function alOfRgb(rgb: Rgb): number {
  const { l, c, h } = rgbToOklch(rgb.r, rgb.g, rgb.b);
  return apparentLightness(l, c, h);
}

function wcagY(rgb: Rgb): number {
  const lin = (x: number) => {
    const ch = x / 255;
    return ch <= 0.04045 ? ch / 12.92 : ((ch + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(rgb.r) + 0.7152 * lin(rgb.g) + 0.0722 * lin(rgb.b);
}

function hueDelta(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

function sumRgb(rgb: Rgb): number {
  return rgb.r + rgb.g + rgb.b;
}

test("H-K solver fused", () => {
  const theme = buildTheme({ ground: REFERENCE_GROUND });
  expect({
    solve: {
      differentiate_h57: solve("differentiate", 0.13, 57),
      alarm_h25: solve("alarm", 0.16, 25),
      anchor_h77: solve("anchor", 0.125, 77),
      stringGreen: solve("differentiate", 0.075, 134),
      baseline: solve("baseline", 0, 250),
    },
    baked: {
      warning: theme.colors.warning,
      error: theme.colors.error,
      emphasis: theme.colors.emphasis,
      success: theme.colors.success,
      auto: theme.colors.auto,
      attention: theme.colors.attention,
    },
  }).toEqual({
    solve: {
      differentiate_h57: "#bb6b25",
      alarm_h25: "#af3434",
      anchor_h77: "#f8bf66",
      stringGreen: "#728e60",
      baseline: "#b4b4b4",
    },
    baked: {
      warning: "#fa9212",
      error: "#af3434",
      emphasis: "#f8bf66",
      success: "#728e60",
      auto: "#34c4db",
      attention: "#d1d242",
    },
  });

  const hueSamples = [0, 90, 180, 255, 300, 359].map((h) => hueFactor(h));
  expect({
    inBand: hueSamples.every((f) => f >= 0.5 && f <= 1),
    magentaOverYellow: hueFactor(300) > hueFactor(110),
    yellowUnderRedOrange: hueFactor(110) < hueFactor(30),
  }).toEqual({
    inBand: true,
    magentaOverYellow: true,
    yellowUnderRedOrange: true,
  });
  expect(hueFactor(30)).toBeCloseTo(0.8428, 3);

  expect(apparentLightness(0.7, 0.15, 255)).toBeGreaterThan(0.7);
  expect(solveLightness(apparentLightness(0.62, 0.1, 57), 0.1, 57)).toBeCloseTo(0.62, 10);

  const dark = buildTheme({ ground: 0.2 });
  const light = buildTheme({ ground: 0.95 });
  expect({
    darkUp: hexToOklch(dark.colors.foreground).l > 0.2,
    lightDown: hexToOklch(light.colors.foreground).l < 0.95,
    accentsDiffer: dark.colors.accent !== light.colors.accent,
    polarity: [canvasPolarity(0.2), canvasPolarity(0.8), canvasPolarity(null)],
  }).toEqual({
    darkUp: true,
    lightDown: true,
    accentsDiffer: true,
    polarity: ["dark", "light", "dark"],
  });

  const targets = (["alarm", "recede", "differentiate", "baseline", "anchor"] as const).map((t) =>
    tierTarget(t, 0.5, "up"),
  );
  expect(targets).toEqual([...targets].sort((a, b) => a - b));

  const gamutHex = solve("anchor", 0.125, 77, { ground: 0.98 });
  const gamut = hexToOklch(gamutHex);
  const emph = hexToOklch(buildTheme({ ground: 0.98 }).colors.emphasis);
  expect({
    solveHueFamily: gamut.h > 70 && gamut.h < 85,
    themeHueFamily: emph.h > 70 && emph.h < 85,
    rust: gamutHex.toLowerCase() === "#542400",
  }).toEqual({
    solveHueFamily: true,
    themeHueFamily: true,
    rust: false,
  });

  expect({
    black: parseOsc11Payload("rgb:0000/0000/0000"),
    white: parseOsc11Payload("rgb:ffff/ffff/ffff"),
    hex: parseOsc11Payload("#1e1e1e"),
    garbage: parseOsc11Payload("not-a-color"),
    bogus: parseOsc11Payload("bogus"),
    xparse2: parseOsc11Payload("rgb:ff/00/00"),
    blackGround: groundFromRgb(0, 0, 0) < 0.1,
    whiteGround: groundFromRgb(255, 255, 255) > 0.9,
  }).toEqual({
    black: { r: 0, g: 0, b: 0 },
    white: { r: 255, g: 255, b: 255 },
    hex: { r: 30, g: 30, b: 30 },
    garbage: null,
    bogus: null,
    xparse2: { r: 255, g: 0, b: 0 },
    blackGround: true,
    whiteGround: true,
  });
});

test.each(GROUNDS.map((ground) => ({ ground })))("contrast-floor at ground $ground", ({ ground }) => {
  const theme = buildTheme({ ground });
  const ctx = { theme, depth: "truecolor" as const };

  const als = FG_LADDER.map(([step, p]) => ({
    step,
    al: alOfRgb(resolveStyle({ role: "foreground", prominence: p }, ctx).fgRgb!),
  }));
  const fgGaps = als.slice(1).map((row, i) => ({
    pair: `${als[i]!.step}->${row.step}`,
    delta: Math.abs(row.al - als[i]!.al),
  }));
  expect(fgGaps.filter((g) => g.delta < JND)).toEqual([]);

  const weakRoles = ALL_ROLES.filter((role) => {
    const al = alOfRgb(resolveStyle({ role, prominence: 1 }, ctx).fgRgb!);
    return Math.abs(al - ground) < JND;
  });
  expect(weakRoles).toEqual([]);

  const panel = resolveStyle({ bgRole: "surface", bgProminence: BgP.panel as number }, ctx);
  const wash = resolveStyle({ bgRole: "surface", bgProminence: BgP.wash as number }, ctx);
  const panelY = wcagY(panel.bgRgb!);
  const washY = wcagY(wash.bgRgb!);
  const relative = Math.abs(panelY - washY) / Math.max(Math.min(panelY, washY), 0.005);
  expect(relative).toBeGreaterThanOrEqual(JND);

  const codeAl = alOfRgb(resolveStyle({ role: "code", prominence: 1 }, ctx).fgRgb!);
  const fgAl = alOfRgb(resolveStyle({ role: "foreground", prominence: 1 }, ctx).fgRgb!);
  expect(Math.abs(codeAl - fgAl)).toBeLessThan(JND);

  const roles: SemanticRole[] = ["code", "muted", "foreground"];
  const oklch = Object.fromEntries(roles.map((r) => [r, hexToOklch(theme.colors[r])])) as Record<
    SemanticRole,
    { l: number; c: number; h: number }
  >;
  const muddled: string[] = [];
  for (let i = 0; i < roles.length; i++) {
    for (let j = i + 1; j < roles.length; j++) {
      const a = roles[i]!;
      const b = roles[j]!;
      const alDelta = Math.abs(
        apparentLightness(oklch[a].l, oklch[a].c, oklch[a].h) - apparentLightness(oklch[b].l, oklch[b].c, oklch[b].h),
      );
      if (!(alDelta >= JND || hueDelta(oklch[a].h, oklch[b].h) >= HUE_FLOOR_DEG)) {
        muddled.push(`${a} vs ${b}`);
      }
    }
  }
  expect(muddled).toEqual([]);

  const alarm: SemanticRole[] = ["error", "diff_del"];
  expect(
    Object.fromEntries(
      alarm.map((role) => {
        const plain = resolveStyle({ role, prominence: 1 }, ctx);
        const bold = resolveStyle({ role, prominence: 1, bold: true }, ctx);
        const plainAl = alOfRgb(plain.fgRgb!);
        const boldAl = alOfRgb(bold.fgRgb!);
        return [
          role,
          {
            jnd: Math.abs(boldAl - ground) >= JND,
            towardGround: Math.abs(boldAl - ground) < Math.abs(plainAl - ground),
          },
        ];
      }),
    ),
  ).toEqual({
    error: { jnd: true, towardGround: true },
    diff_del: { jnd: true, towardGround: true },
  });

  const painted = (["mist", "wash", "panel"] as const).map((step) => {
    const style = {
      bgRole: "diff_add" as const,
      bgProminence: BgP[step] as number,
    };
    const plain = resolveStyle(style, ctx);
    const selected = resolveStyle({ ...style, selected: true }, ctx);
    return {
      step,
      delta: Math.abs(alOfRgb(selected.bgRgb!) - alOfRgb(plain.bgRgb!)),
      awayFromGround: Math.abs(alOfRgb(selected.bgRgb!) - ground) > Math.abs(alOfRgb(plain.bgRgb!) - ground),
    };
  });
  expect(painted.filter((row) => row.delta < JND)).toEqual([]);
  expect(painted.every((row) => row.awayFromGround)).toBe(true);
  const mistBg = resolveStyle({ bgRole: "diff_add", bgProminence: BgP.mist as number }, ctx).bgRgb!;
  const washBg = resolveStyle({ bgRole: "diff_add", bgProminence: BgP.wash as number }, ctx).bgRgb!;
  expect(Math.abs(alOfRgb(mistBg) - ground)).toBeLessThan(Math.abs(alOfRgb(washBg) - ground));
  expect(rgbToOklch(mistBg.r, mistBg.g, mistBg.b).c).toBeLessThan(rgbToOklch(washBg.r, washBg.g, washBg.b).c);
});

test.each([
  {
    name: "depth truecolor field shape",
    oracle: () => {
      const theme = buildTheme({ ground: REFERENCE_GROUND });
      const ctx = { theme, depth: "truecolor" as const };
      const fg = resolveStyle({ role: "error", prominence: 1 }, ctx);
      const solid = resolveStyle({ bgRole: "surface", bgProminence: BgP.solid as number }, ctx);
      const wash = resolveStyle({ bgRole: "surface", bgProminence: BgP.wash as number }, ctx);
      const unset = resolveStyle({ bgRole: "surface" }, ctx);
      expect({
        fgIndex: fg.fg,
        role: fg.role,
        hasFgRgb: fg.fgRgb !== undefined,
        hasSolidBg: solid.bgRgb !== undefined,
        washDarker: sumRgb(wash.bgRgb!) < sumRgb(solid.bgRgb!),
        washDiffers: JSON.stringify(solid.bgRgb) !== JSON.stringify(wash.bgRgb),
        defaultSolid: unset.bgRgb,
      }).toEqual({
        fgIndex: undefined,
        role: "error",
        hasFgRgb: true,
        hasSolidBg: true,
        washDarker: true,
        washDiffers: true,
        defaultSolid: solid.bgRgb,
      });
    },
  },
  {
    name: "depth ansi256 field shape",
    oracle: () => {
      const theme = buildTheme({ ground: REFERENCE_GROUND });
      const error = resolveStyle({ role: "error" }, { theme, depth: "ansi256" });
      const bg = resolveStyle({ bgRole: "surface", bgProminence: BgP.panel as number }, { theme, depth: "ansi256" });
      expect({
        fg: error.fg,
        nearest: nearestAnsi256FromRgb(theme.rgb.error!),
        fgRgb: error.fgRgb,
        bgIndexed: bg.bg! >= 16,
        bgRgb: bg.bgRgb,
      }).toEqual({
        fg: nearestAnsi256FromRgb(theme.rgb.error!),
        nearest: nearestAnsi256FromRgb(theme.rgb.error!),
        fgRgb: undefined,
        bgIndexed: true,
        bgRgb: undefined,
      });
    },
  },
  {
    name: "depth ansi16 field shape",
    oracle: () => {
      const theme = buildTheme({ ground: 0.2 });
      const ctx = { theme, depth: "ansi16" as const };
      const error = resolveStyle({ role: "error", prominence: 1 }, ctx);
      const muted = resolveStyle({ role: "muted", prominence: 0.4 }, ctx);
      const accent = resolveStyle({ role: "accent", prominence: 1 }, ctx);
      const lit = resolveStyle({ fgRgb: { r: 249, g: 40, b: 40 } }, ctx);
      const bg = resolveStyle({ bgRgb: { r: 20, g: 40, b: 20 } }, ctx);
      const both = resolveStyle({ fgRgb: { r: 0, g: 200, b: 80 }, bgRgb: { r: 10, g: 30, b: 10 } }, ctx);
      const bgRole = resolveStyle({ bgRole: "surface", bgProminence: BgP.solid as number }, ctx);
      expect({
        errorFg: error.fg,
        errorRgb: error.fgRgb,
        mutedFg: muted.fg,
        mutedRgb: muted.fgRgb,
        accentFg: accent.fg,
        accentRgb: accent.fgRgb,
        errorSlotLoud: ansi16Slot("error", "dark", 1),
        errorSlotSoft: ansi16Slot("error", "dark", 0.5),
        litIn16: lit.fg! >= 0 && lit.fg! <= 15,
        litRgb: lit.fgRgb,
        bgIn16: bg.bg! >= 0 && bg.bg! <= 15,
        bgRgb: bg.bgRgb,
        bothFgIn16: both.fg! >= 0 && both.fg! <= 15,
        bothBgIn16: both.bg! >= 0 && both.bg! <= 15,
        bothRgb: [both.fgRgb, both.bgRgb],
        bgRoleIn16: bgRole.bg! >= 0 && bgRole.bg! <= 15,
        bgRoleRgb: bgRole.bgRgb,
      }).toEqual({
        errorFg: 9,
        errorRgb: undefined,
        mutedFg: 8,
        mutedRgb: undefined,
        accentFg: 14,
        accentRgb: undefined,
        errorSlotLoud: 9,
        errorSlotSoft: 1,
        litIn16: true,
        litRgb: undefined,
        bgIn16: true,
        bgRgb: undefined,
        bothFgIn16: true,
        bothBgIn16: true,
        bothRgb: [undefined, undefined],
        bgRoleIn16: true,
        bgRoleRgb: undefined,
      });
    },
  },
  {
    name: "ansi256 nearest",
    oracle: () => {
      const white = nearestAnsi256(255, 255, 255);
      const black = nearestAnsi256(0, 0, 0);
      const w = ansi256ToRgb(white);
      const b = ansi256ToRgb(black);
      expect({
        whiteRange: white >= 16 && white <= 255,
        whiteBright: w.r + w.g + w.b > 600,
        blackDark: b.r + b.g + b.b < 40,
        redCenter: nearestAnsi256(255, 0, 0),
      }).toEqual({
        whiteRange: true,
        whiteBright: true,
        blackDark: true,
        redCenter: 196,
      });
    },
  },
  {
    name: "do not pre-resolve (double fade)",
    oracle: () => {
      const theme = buildTheme({ ground: 0.2 });
      const once = resolveStyle({ role: "foreground", regionProminence: 0.4 }, { theme, depth: "truecolor" });
      const twice = resolveStyle(once, { theme, depth: "truecolor" });
      expect({
        onceRgb: once.fgRgb !== undefined,
        region: once.regionProminence,
        fadedAgain: sumRgb(twice.fgRgb!) < sumRgb(once.fgRgb!),
      }).toEqual({ onceRgb: true, region: 0.4, fadedAgain: true });
    },
  },
  {
    name: "fgRgb + role recasts to role AL; fgRgb alone is claimed",
    oracle: () => {
      const theme = buildTheme({ ground: 0.2 });
      const ctx = { theme, depth: "truecolor" as const };
      const syntax = { r: 249, g: 117, b: 131 };
      const claimed = resolveStyle({ fgRgb: syntax }, ctx);
      const recast = resolveStyle({ role: "code", fgRgb: syntax, prominence: 1 }, ctx);
      const code = resolveStyle({ role: "code", prominence: 1 }, ctx);
      const faded = resolveStyle({ role: "code", fgRgb: syntax, prominence: FgP.secondary as number }, ctx);
      const codeFaded = resolveStyle({ role: "code", prominence: FgP.secondary as number }, ctx);
      const tokHue = rgbToOklch(syntax.r, syntax.g, syntax.b).h;
      const recastHue = rgbToOklch(recast.fgRgb!.r, recast.fgRgb!.g, recast.fgRgb!.b).h;
      expect({
        claimed: claimed.fgRgb,
        hue: hueDelta(tokHue, recastHue) < HUE_FLOOR_DEG,
        al: Math.abs(alOfRgb(recast.fgRgb!) - alOfRgb(code.fgRgb!)) < JND,
        fadedAl: Math.abs(alOfRgb(faded.fgRgb!) - alOfRgb(codeFaded.fgRgb!)) < JND,
      }).toEqual({
        claimed: syntax,
        hue: true,
        al: true,
        fadedAl: true,
      });
    },
  },
  {
    name: "selection hue-preserve (Zed #17313) + fill + indexed emit",
    oracle: () => {
      const ground = 0.2;
      const theme = buildTheme({ ground });
      const diffRed: Rgb = { r: 0xff, g: 0x70, b: 0x70 };
      const out = selectionRecolorRgb(diffRed, ground);
      const dHue = hueDelta(rgbToOklch(diffRed.r, diffRed.g, diffRed.b).h, rgbToOklch(out.r, out.g, out.b).h);
      const cell: Rgb = { r: 0xc0, g: 0xc0, b: 0xc0 };
      const before = rgbToOklch(cell.r, cell.g, cell.b);
      const shifted = selectionRecolorRgb(cell, ground);
      const after = rgbToOklch(shifted.r, shifted.g, shifted.b);
      const selected = resolveStyle({ fgRgb: diffRed, selected: true }, { theme, depth: "truecolor" });
      const bg = { r: 40, g: 20, b: 20 };
      const selectedBg = resolveStyle({ bgRgb: bg, selected: true }, { theme, depth: "truecolor" });
      const plain16 = resolveStyle({ role: "accent" }, { theme, depth: "ansi16" });
      const selected16 = resolveStyle({ role: "accent", selected: true }, { theme, depth: "ansi16" });
      const plain256 = resolveStyle({ role: "foreground" }, { theme, depth: "ansi256" });
      const selected256 = resolveStyle({ role: "foreground", selected: true }, { theme, depth: "ansi256" });
      expect({
        huePreserved: dHue < 1,
        alUp: apparentLightness(after.l, after.c, after.h) > apparentLightness(before.l, before.c, before.h),
        identity: selectionRecolorRgb({ r: 100, g: 150, b: 200 }, 0.2, 0),
        shiftBudget: SELECTION_SHIFT >= 0.08 && SELECTION_SHIFT <= 0.1,
        redFamily: selected.fgRgb!.r > selected.fgRgb!.b && selected.fgRgb!.r > selected.fgRgb!.g,
        bgChanged: selectedBg.bgRgb !== undefined && JSON.stringify(selectedBg.bgRgb) !== JSON.stringify(bg),
        ansi16: {
          hasFg: selected16.fg !== undefined,
          hasBg: selected16.bg !== undefined,
          plainBg: plain16.bg,
          rgb: [selected16.fgRgb, selected16.bgRgb],
        },
        ansi256: {
          hasFg: selected256.fg !== undefined,
          hasBg: selected256.bg !== undefined,
          plainBg: plain256.bg,
          rgb: [selected256.fgRgb, selected256.bgRgb],
        },
      }).toEqual({
        huePreserved: true,
        alUp: true,
        identity: { r: 100, g: 150, b: 200 },
        shiftBudget: true,
        redFamily: true,
        bgChanged: true,
        ansi16: {
          hasFg: true,
          hasBg: true,
          plainBg: undefined,
          rgb: [undefined, undefined],
        },
        ansi256: {
          hasFg: true,
          hasBg: true,
          plainBg: undefined,
          rgb: [undefined, undefined],
        },
      });
    },
  },
  {
    name: "ghost dim only at ansi16; authored dim dropped; literal keeps dim",
    oracle: () => {
      const theme = buildTheme({ ground: 0.2 });
      const ghost = { role: "foreground", prominence: FgP.ghost as number };
      const truecolor = resolveStyle(ghost, { theme, depth: "truecolor" });
      const ansi256 = resolveStyle(ghost, { theme, depth: "ansi256" });
      const ansi16 = resolveStyle(ghost, { theme, depth: "ansi16" });
      const whisper = resolveStyle(
        { role: "foreground", prominence: FgP.whisper as number },
        { theme, depth: "ansi16" },
      );
      const secondary = resolveStyle(
        { role: "foreground", prominence: FgP.secondary as number },
        { theme, depth: "ansi16" },
      );
      const authored = resolveStyle(
        { role: "foreground", prominence: FgP.primary as number, dim: true },
        { theme, depth: "truecolor" },
      );
      const literal = resolveStyle({ fgRgb: { r: 200, g: 100, b: 100 }, dim: true }, { theme, depth: "truecolor" });
      expect({
        truecolor: truecolor.dim,
        ansi256: ansi256.dim,
        ansi16: ansi16.dim,
        whisper: whisper.dim,
        secondary: secondary.dim,
        authored: authored.dim,
        literal: literal.dim,
      }).toEqual({
        truecolor: undefined,
        ansi256: undefined,
        ansi16: true,
        whisper: true,
        secondary: undefined,
        authored: undefined,
        literal: true,
      });
    },
  },
  {
    name: "mono: zero color fields; attributes survive; ghost still dims",
    oracle: () => {
      const theme = buildTheme({ ground: REFERENCE_GROUND });
      const ctx = { theme, depth: "mono" as const };
      const role = resolveStyle({ role: "accent", prominence: 1 }, ctx);
      const literal = resolveStyle({ fgRgb: { r: 249, g: 117, b: 131 }, bgRgb: { r: 20, g: 40, b: 20 } }, ctx);
      const bgRole = resolveStyle(
        { bgRole: "surface", bgProminence: BgP.solid as number },
        { theme: buildTheme({ ground: 0.2 }), depth: "mono" },
      );
      const attrs = resolveStyle(
        {
          role: "foreground",
          bold: true,
          italic: true,
          strike: true,
          underline: true,
        },
        ctx,
      );
      const ghost = resolveStyle(
        { role: "foreground", prominence: FgP.ghost as number },
        { theme: buildTheme({ ground: 0.2 }), depth: "mono" },
      );
      const whisper = resolveStyle(
        { role: "foreground", prominence: FgP.whisper as number },
        { theme: buildTheme({ ground: 0.2 }), depth: "mono" },
      );
      const secondary = resolveStyle(
        { role: "foreground", prominence: FgP.secondary as number },
        { theme: buildTheme({ ground: 0.2 }), depth: "mono" },
      );
      const colorKeys = (s: { fg?: number; fgRgb?: Rgb; bg?: number; bgRgb?: Rgb }) => ({
        fg: s.fg,
        fgRgb: s.fgRgb,
        bg: s.bg,
        bgRgb: s.bgRgb,
      });
      expect({
        role: colorKeys(role),
        literal: colorKeys(literal),
        bgRole: { bg: bgRole.bg, bgRgb: bgRole.bgRgb },
        attrs: {
          bold: attrs.bold,
          italic: attrs.italic,
          strike: attrs.strike,
          underline: attrs.underline,
          ...colorKeys(attrs),
        },
        ghostDim: ghost.dim,
        whisperDim: whisper.dim,
        secondaryDim: secondary.dim,
        ghostColor: colorKeys(ghost),
      }).toEqual({
        role: { fg: undefined, fgRgb: undefined, bg: undefined, bgRgb: undefined },
        literal: {
          fg: undefined,
          fgRgb: undefined,
          bg: undefined,
          bgRgb: undefined,
        },
        bgRole: { bg: undefined, bgRgb: undefined },
        attrs: {
          bold: true,
          italic: true,
          strike: true,
          underline: true,
          fg: undefined,
          fgRgb: undefined,
          bg: undefined,
          bgRgb: undefined,
        },
        ghostDim: true,
        whisperDim: true,
        secondaryDim: undefined,
        ghostColor: {
          fg: undefined,
          fgRgb: undefined,
          bg: undefined,
          bgRgb: undefined,
        },
      });
    },
  },
  {
    name: "bold toward ground both polarities; FG-only; then selection once",
    oracle: () => {
      const dark = buildTheme({ ground: 0.2 });
      const light = buildTheme({ ground: 0.85 });
      const plainDark = resolveStyle({ role: "foreground", prominence: 1 }, { theme: dark, depth: "truecolor" });
      const boldDark = resolveStyle(
        { role: "foreground", prominence: 1, bold: true },
        { theme: dark, depth: "truecolor" },
      );
      const plainLight = resolveStyle({ role: "foreground", prominence: 1 }, { theme: light, depth: "truecolor" });
      const boldLight = resolveStyle(
        { role: "foreground", prominence: 1, bold: true },
        { theme: light, depth: "truecolor" },
      );
      const panel = {
        role: "error",
        bgRole: "surface",
        bgProminence: BgP.panel as number,
      };
      const plainPanel = resolveStyle(panel, { theme: dark, depth: "truecolor" });
      const boldPanel = resolveStyle({ ...panel, bold: true }, { theme: dark, depth: "truecolor" });
      const bgLit = { r: 40, g: 40, b: 48 };
      const boldLit = resolveStyle({ bgRgb: bgLit, bold: true }, { theme: dark, depth: "truecolor" });
      const boldOnly = resolveStyle({ role: "accent", bold: true }, { theme: dark, depth: "truecolor" });
      const boldSelected = resolveStyle(
        { role: "accent", bold: true, selected: true },
        { theme: dark, depth: "truecolor" },
      );
      expect({
        darkTowardGround: sumRgb(boldDark.fgRgb!) < sumRgb(plainDark.fgRgb!),
        lightTowardGround: sumRgb(boldLight.fgRgb!) > sumRgb(plainLight.fgRgb!),
        panelBg: boldPanel.bgRgb,
        panelFgChanged: JSON.stringify(boldPanel.fgRgb) !== JSON.stringify(plainPanel.fgRgb),
        literalBg: boldLit.bgRgb,
        boldThenSelection: boldSelected.fgRgb,
      }).toEqual({
        darkTowardGround: true,
        lightTowardGround: true,
        panelBg: plainPanel.bgRgb,
        panelFgChanged: true,
        literalBg: bgLit,
        boldThenSelection: selectionRecolorRgb(boldOnly.fgRgb!, dark.ground),
      });
    },
  },
  {
    name: "FG prominence dissolves toward local surface / cell bgRole",
    oracle: () => {
      const theme = buildTheme({ ground: 0.2 });
      const ctx = { theme, depth: "truecolor" as const };
      const surface = resolveStyle({ bgRole: "surface", bgProminence: BgP.panel as number }, ctx);
      const onPanel = resolveStyle(
        {
          role: "muted",
          prominence: 0.05,
          surfaceRole: "surface",
          surfaceProminence: BgP.panel as number,
        },
        ctx,
      );
      const onGround = resolveStyle({ role: "muted", prominence: 0.05 }, ctx);
      const withBg = resolveStyle(
        {
          role: "muted",
          prominence: 0.08,
          bgRole: "surface",
          bgProminence: BgP.panel as number,
        },
        ctx,
      );
      const viaSurface = resolveStyle(
        {
          role: "muted",
          prominence: 0.08,
          surfaceRole: "surface",
          surfaceProminence: BgP.panel as number,
        },
        ctx,
      );
      const dPanel = Math.abs(sumRgb(onPanel.fgRgb!) - sumRgb(surface.bgRgb!));
      const dGround = Math.abs(sumRgb(onGround.fgRgb!) - sumRgb(surface.bgRgb!));
      expect({ closerToSurface: dPanel < dGround, withBg: withBg.fgRgb }).toEqual({
        closerToSurface: true,
        withBg: viaSurface.fgRgb,
      });
    },
  },
  {
    name: "transparent FG at p=0 matches probed terminal ground RGB",
    oracle: () => {
      const groundRgb = { r: 28, g: 24, b: 20 };
      const theme = buildTheme({ groundRgb });
      const gone = resolveStyle({ role: "muted", prominence: 0 }, { theme, depth: "truecolor" });
      expect(gone.fgRgb).toEqual(theme.groundRgb);
    },
  },
  {
    name: "region × bg independent; fuse contour; quadratic de-chroma",
    oracle: () => {
      const theme = buildTheme({ ground: 0.2 });
      const ctx = { theme, depth: "truecolor" as const };
      const full = resolveStyle(
        {
          role: "foreground",
          bgRole: "surface",
          bgProminence: BgP.solid as number,
        },
        ctx,
      );
      const bgFaded = resolveStyle(
        {
          role: "foreground",
          bgRole: "surface",
          bgProminence: BgP.wash as number,
        },
        ctx,
      );
      const regionDimmed = resolveStyle(
        {
          role: "foreground",
          bgRole: "surface",
          bgProminence: BgP.solid as number,
          regionProminence: 0.45,
        },
        ctx,
      );
      const bgOnly = resolveStyle({ bgRole: "surface", bgProminence: 0.5 }, ctx);
      const regionOnly = resolveStyle({ bgRole: "surface", bgProminence: 1, regionProminence: 0.5 }, ctx);
      const both = resolveStyle({ bgRole: "surface", bgProminence: 0.5, regionProminence: 1 }, ctx);
      const bg = { r: 40, g: 60, b: 40 };
      const lowFg = resolveStyle({ prominence: 0.2, bgRgb: bg }, ctx);
      const fullFg = resolveStyle({ prominence: 1, bgRgb: bg }, ctx);
      const contour = resolveStyle({ role: "foreground", prominence: FgP.ghost as number }, ctx);
      const fused0 = resolveStyle(
        {
          role: "warning",
          prominence: 0,
          fuseRole: "foreground",
          fuseProminence: FgP.ghost as number,
        },
        ctx,
      );
      const live = resolveStyle({ role: "warning", prominence: 1 }, ctx);
      const mid = resolveStyle(
        {
          role: "warning",
          prominence: 0.6,
          fuseRole: "foreground",
          fuseProminence: FgP.ghost as number,
        },
        ctx,
      );
      const chroma = (rgb: Rgb) => rgbToOklch(rgb.r, rgb.g, rgb.b).c;
      expect({
        fgUntouchedByBgP: bgFaded.fgRgb,
        bgFaded: JSON.stringify(bgFaded.bgRgb) !== JSON.stringify(full.bgRgb),
        regionFg: JSON.stringify(regionDimmed.fgRgb) !== JSON.stringify(full.fgRgb),
        regionBg: JSON.stringify(regionDimmed.bgRgb) !== JSON.stringify(full.bgRgb),
        multiplicative: { bgOnly: bgOnly.bgRgb, regionOnly: regionOnly.bgRgb },
        both: both.bgRgb,
        literalBgIgnoresFgP: lowFg.bgRgb,
        p0Contour: fused0.fgRgb,
        quadratic: chroma(mid.fgRgb!) < (chroma(contour.fgRgb!) + chroma(live.fgRgb!)) / 2,
      }).toEqual({
        fgUntouchedByBgP: full.fgRgb,
        bgFaded: true,
        regionFg: true,
        regionBg: true,
        multiplicative: { bgOnly: regionOnly.bgRgb, regionOnly: regionOnly.bgRgb },
        both: bgOnly.bgRgb,
        literalBgIgnoresFgP: fullFg.bgRgb,
        p0Contour: contour.fgRgb,
        quadratic: true,
      });
    },
  },
])("resolveStyle $name", ({ oracle }) => {
  oracle();
});

test("progress fuse under region dim lands on the dimmed contour", () => {
  const theme = buildTheme({ ground: 0.2 });
  const ctx = { theme, depth: "truecolor" as const };
  const fuse = {
    role: "foreground" as const,
    fuseRole: "foreground" as const,
    fuseProminence: FgP.ghost as number,
    tintRole: "warning" as const,
    tint: 0.5,
  };
  const dimContour = resolveStyle({ role: "foreground", prominence: FgP.ghost as number, regionProminence: 0.4 }, ctx);
  const fused0 = resolveStyle({ ...fuse, prominence: 0, regionProminence: 0.4 }, ctx);
  const hot = resolveStyle({ ...fuse, prominence: 1 }, ctx);
  const hotDim = resolveStyle({ ...fuse, prominence: 1, regionProminence: 0.4 }, ctx);
  const lum = (rgb: Rgb) => 0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b;
  expect({
    p0: fused0.fgRgb,
    hotterWhenUndimmed: lum(hot.fgRgb!) > lum(hotDim.fgRgb!),
  }).toEqual({
    p0: dimContour.fgRgb,
    hotterWhenUndimmed: true,
  });
});

test("tintRole warms chroma toward warning; hue is the tint identity", () => {
  const theme = buildTheme({ ground: REFERENCE_GROUND });
  const ctx = { theme, depth: "truecolor" as const };
  const muted = resolveStyle({ role: "muted", prominence: 1 }, ctx);
  const warning = resolveStyle({ role: "warning", prominence: 1 }, ctx);
  const mid = resolveStyle({ role: "muted", prominence: 1, tintRole: "warning", tint: 0.5 }, ctx);
  const chroma = (rgb: Rgb) => rgbToOklch(rgb.r, rgb.g, rgb.b).c;
  const hue = (rgb: Rgb) => rgbToOklch(rgb.r, rgb.g, rgb.b).h;
  expect({
    hotterThanMuted: chroma(mid.fgRgb!) > chroma(muted.fgRgb!),
    coolerThanWarning: chroma(mid.fgRgb!) < chroma(warning.fgRgb!),
    warningHue: Math.abs(hue(mid.fgRgb!) - hue(warning.fgRgb!)) < 1,
  }).toEqual({
    hotterThanMuted: true,
    coolerThanWarning: true,
    warningHue: true,
  });
});
