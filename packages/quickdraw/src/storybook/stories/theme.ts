/**
 * Theme / salience stories — roles, depth ladder, region dim, ground attune,
 * H-K full palette lineup (hue/chroma/tier/prominence — not hand ANSI).
 * No harness imports; pure LayoutNode builds via theme resolve.
 */

import { Panel } from "./demo-atoms.js";
import { type Rgb, type SemanticRole } from "../../lexicon/index.js";
import {
  apparentLightness,
  buildTheme,
  DEFAULT_SEEDS,
  defaultTheme,
  groundFromRgb,
  hexToOklch,
  hexToRgb,
  HK_K,
  nearestAnsi256FromRgb,
  resolveStyle,
  solve,
  tierTarget,
  type Theme,
} from "../../theme/index.js";
import { Text } from "../../widgets/index.js";
import type { Story } from "../types.js";

// `resolveStyle` returns theme's StyleLike (`role`/`bgRole: string`); widgets'
// TextStyle narrows both to the lexicon's SemanticRole union — the literals
// passed in are always valid members, so this boundary widening is exact.
const asRole = <T extends { role?: string; bgRole?: string }>(s: T) =>
  s as Omit<T, "role" | "bgRole"> & {
    role?: SemanticRole;
    bgRole?: SemanticRole;
  };

/** Sample terminal grounds (sRGB) for ground-attune multi-sample. */
const SAMPLE_GROUNDS: readonly [number, number, number][] = [
  [12, 12, 16], // near-black dark terminal
  [32, 36, 48], // blue-grey dark
  [248, 248, 250], // light terminal
];

/**
 * Ink that contrasts against a given OKLCH L (not "always theme.foreground").
 * Light surfaces → dark baseline ink; dark surfaces → light baseline ink.
 * Fixes light-ground emphasis (#542400) painted on dark Panel 235 (invisible).
 */
function inkAgainstL(bgL: number): Rgb {
  const polarity = bgL >= 0.5 ? "down" : "up";
  // solve baseline against the *surface* so ink tracks the swatch, not OSC ground alone
  return hexToRgb(solve("baseline", 0.02, 250, { ground: bgL, polarity }));
}

function inkOn(theme: Theme, bgRole: SemanticRole): Rgb {
  return inkAgainstL(hexToOklch(theme.colors[bgRole]!).l);
}

export const THEME_STORIES: Story[] = [
  {
    id: "theme-hk-lineup",
    name: "H-K palette lineup",
    category: "theme",
    family: "lineup",
    description: "Gallery: full seed palette × grounds × prominence ladder (H-K, not ANSI hand-picks)",
    sampleCount: SAMPLE_GROUNDS.length,
    build: (ctx) => {
      // sample cycles terminal ground → full re-solve (same seeds, new L)
      const groundRgb = SAMPLE_GROUNDS[ctx.sample % SAMPLE_GROUNDS.length]!;
      const ground = groundFromRgb(groundRgb[0], groundRgb[1], groundRgb[2]);
      const theme = buildTheme({
        ground,
        id: `hk-lineup-${ctx.sample % SAMPLE_GROUNDS.length}`,
        name: `H-K L=${ground.toFixed(3)}`,
      });
      const w = Math.min(64, Math.max(40, ctx.cols));
      const polarity = ground < 0.5 ? "up" : "down";
      const muted = asRole(resolveStyle({ role: "muted" }, { theme }));
      const emph = asRole(resolveStyle({ role: "emphasis" }, { theme }));
      const fg = asRole(resolveStyle({ role: "foreground" }, { theme }));
      // CRITICAL: paint on the ground this theme was solved for.
      // Was Panel bg=235 always → light-ground palette (dark ink, dark emph)
      // sat on dark chrome → emphasis looked like a black hole (#542400 on 235).
      const groundBg = hexToRgb(theme.groundHex);

      const kids = [
        Text(`H-K Nayatani-3h · K=${HK_K} · ground L=${ground.toFixed(3)} pol=${polarity} · ←/→`, {
          key: "hk:hdr",
          style: { bold: true, ...emph },
          whiteSpace: "nowrap",
        }),
        Text(`sRGB(${groundRgb.join(",")}) · surface=ground (not Panel 235) · L=target−K·C·f`, {
          key: "hk:seed-lbl",
          style: muted,
          whiteSpace: "nowrap",
        }),
        ...DEFAULT_SEEDS.map((seed) => {
          const st = asRole(resolveStyle({ role: seed.name }, { theme }));
          const hex = theme.colors[seed.name]!;
          const o = hexToOklch(hex);
          const al = apparentLightness(o.l, o.c, o.h);
          const target = tierTarget(seed.tier, ground);
          // target vs al: should match (~H-K inverse). Anchor on light = low target
          // (max contrast down) → yellow becomes dark brown — expected, not a bug.
          return Text(
            `${seed.name.padEnd(11)} h=${String(seed.h).padStart(3)} c=${seed.c.toFixed(3)} ${seed.tier.padEnd(13)} →${target.toFixed(2)} al=${al.toFixed(2)}  ██ ${hex}`,
            {
              key: `hk:seed:${seed.name}`,
              style: st,
              whiteSpace: "nowrap",
            },
          );
        }),
        Text("prominence ladder · role=error (own p → regionDim toward ground)", {
          key: "hk:prom-lbl",
          style: muted,
          whiteSpace: "nowrap",
        }),
        ...([1, 0.75, 0.5, 0.35, 0.2] as const).map((p) => {
          const st = resolveStyle({ role: "error", prominence: p }, { theme });
          return Text(`  p=${p.toFixed(2)}  ████████  error → ground`.slice(0, w - 4), {
            key: `hk:prom:${p}`,
            style: asRole(st),
            whiteSpace: "nowrap",
          });
        }),
        Text("background swatches · role as bgRgb + inkAgainstL(bg)", {
          key: "hk:bg-lbl",
          style: muted,
          whiteSpace: "nowrap",
        }),
        {
          type: "flex" as const,
          key: "hk:bg-row",
          style: { direction: "row" as const, gap: 0 },
          children: DEFAULT_SEEDS.slice(0, 8).map((seed) =>
            Text(` ${seed.name.slice(0, 4)} `, {
              key: `hk:bg:${seed.name}`,
              whiteSpace: "nowrap" as const,
              style: {
                fgRgb: inkOn(theme, seed.name),
                bgRgb: theme.rgb[seed.name]!,
              },
            }),
          ),
        },
        {
          type: "flex" as const,
          key: "hk:bg-row2",
          style: { direction: "row" as const, gap: 0 },
          children: DEFAULT_SEEDS.slice(8).map((seed) =>
            Text(` ${seed.name.slice(0, 6)} `, {
              key: `hk:bg2:${seed.name}`,
              whiteSpace: "nowrap" as const,
              style: {
                fgRgb: inkOn(theme, seed.name),
                bgRgb: theme.rgb[seed.name]!,
              },
            }),
          ),
        },
        Text("equal-tier hue strip · tier=differentiate C=0.10 (H-K levels blues vs warms)", {
          key: "hk:hue-lbl",
          style: muted,
          whiteSpace: "nowrap",
        }),
        {
          type: "flex" as const,
          key: "hk:hue-row",
          style: { direction: "row" as const, gap: 1 },
          children: ([25, 57, 90, 134, 200, 242, 255, 320] as const).map((h) => {
            const hex = solve("differentiate", 0.1, h, {
              ground: theme.ground,
            });
            const rgb = hexToRgb(hex);
            return Text(`h${h}`, {
              key: `hk:hue:${h}`,
              whiteSpace: "nowrap" as const,
              style: { fgRgb: rgb, bold: true },
            });
          }),
        },
        {
          type: "flex" as const,
          key: "hk:hue-bg-row",
          style: { direction: "row" as const, gap: 0 },
          children: ([25, 57, 90, 134, 200, 242, 255, 320] as const).map((h) => {
            const hex = solve("differentiate", 0.1, h, {
              ground: theme.ground,
            });
            const rgb = hexToRgb(hex);
            const o = hexToOklch(hex);
            return Text(` ${String(h).padStart(3)} `, {
              key: `hk:huebg:${h}`,
              whiteSpace: "nowrap" as const,
              style: {
                fgRgb: inkAgainstL(o.l),
                bgRgb: rgb,
              },
            });
          }),
        },
      ];

      // Not Panel() — that hardcodes bg 235 and lies about light-ground attunement.
      return {
        type: "box" as const,
        key: "hk-lineup",
        style: {
          border: true,
          width: w,
          height: Math.min(kids.length + 3, Math.max(16, ctx.rows)),
          padding: 1,
          background: { bgRgb: groundBg },
        },
        children: [
          Text("theme-hk-lineup", {
            key: "hk:title",
            style: { bold: true, ...fg },
            whiteSpace: "nowrap",
          }),
          ...kids,
        ],
      };
    },
  },
  {
    id: "theme-depth-ladder",
    name: "Depth ladder",
    category: "theme",
    family: "depth",
    description: "Same accent role: truecolor fgRgb vs nearestAnsi256 index style",
    build: (ctx) => {
      const theme = defaultTheme;
      const role: SemanticRole = "accent";
      const tc = asRole(resolveStyle({ role }, { theme, depth: "truecolor" }));
      const a256 = asRole(resolveStyle({ role }, { theme, depth: "ansi256" }));
      const idx = a256.fg ?? nearestAnsi256FromRgb(theme.rgb[role]!);
      return Panel(
        [
          Text("role: accent", {
            style: {
              bold: true,
              ...asRole(resolveStyle({ role: "foreground" }, { theme })),
            },
          }),
          Text(`truecolor  fgRgb=${JSON.stringify(tc.fgRgb)}`, {
            style: tc,
          }),
          Text(`ansi256    fg=${idx}`, {
            style: a256,
          }),
          Text("truecolor sample ·········", { style: tc }),
          Text("ansi256 sample ··········", { style: a256 }),
        ],
        {
          title: "depth ladder",
          width: Math.min(48, ctx.cols),
          height: Math.min(10, ctx.rows),
        },
      );
    },
  },
  {
    id: "theme-region-dim",
    name: "Region dim",
    category: "theme",
    family: "region",
    description:
      "Stamp regionProminence 0.4 on intents — paint resolves once. Do not pre-resolve: baked fgRgb + leftover regionP fades twice.",
    build: (ctx) => {
      return Panel(
        [
          Text("Primary focus line", {
            style: { role: "foreground", bold: true },
          }),
          Text("Accent callout", { style: { role: "accent" } }),
          Text("foreground × region 0.4", {
            style: { role: "foreground", regionProminence: 0.4 },
          }),
          Text("muted × region 0.4 (recede-tier floor)", {
            style: { role: "muted", regionProminence: 0.4 },
          }),
        ],
        {
          title: "region dim",
          width: Math.min(44, ctx.cols),
          height: Math.min(10, ctx.rows),
        },
      );
    },
  },
  {
    id: "theme-ground-attune",
    name: "Ground attune",
    category: "theme",
    family: "attune",
    description: "buildTheme against different ground RGB (ctx.sample cycles grounds)",
    sampleCount: SAMPLE_GROUNDS.length,
    build: (ctx) => {
      const rgb = SAMPLE_GROUNDS[ctx.sample % SAMPLE_GROUNDS.length]!;
      const ground = groundFromRgb(rgb[0], rgb[1], rgb[2]);
      const theme = buildTheme({
        ground,
        id: `ground-${ctx.sample % SAMPLE_GROUNDS.length}`,
        name: `ground L=${ground.toFixed(3)}`,
      });
      const roles: SemanticRole[] = ["foreground", "accent", "error", "success"];
      const fg = asRole(resolveStyle({ role: "foreground" }, { theme }));
      const muted = asRole(resolveStyle({ role: "muted" }, { theme }));
      const groundBg = hexToRgb(theme.groundHex);
      const w = Math.min(48, ctx.cols);
      return {
        type: "box" as const,
        key: "ground-attune",
        style: {
          border: true,
          width: w,
          height: Math.min(12, Math.max(8, ctx.rows)),
          padding: 1,
          background: { bgRgb: groundBg },
        },
        children: [
          Text("ground attune", {
            style: { bold: true, ...fg },
            whiteSpace: "nowrap",
          }),
          Text(`ground sRGB(${rgb.join(",")}) L=${ground.toFixed(3)}`, {
            style: { bold: true, ...fg },
            whiteSpace: "nowrap",
          }),
          Text(`sample ${(ctx.sample % SAMPLE_GROUNDS.length) + 1}/${SAMPLE_GROUNDS.length}`, {
            style: muted,
            whiteSpace: "nowrap",
          }),
          ...roles.map((role) =>
            Text(`${role.padEnd(12)} attuned`, {
              style: asRole(resolveStyle({ role }, { theme })),
              whiteSpace: "nowrap",
            }),
          ),
        ],
      };
    },
  },
  {
    id: "theme-selection-recolor",
    name: "Selection recolor",
    category: "theme",
    family: "selection",
    description: "identity-preserving FG AL + accent wash — not reverse-video. Drag the demo pane.",
    sampleCount: 2,
    build: (ctx) => {
      const theme = defaultTheme;
      const fg = asRole(resolveStyle({ role: "foreground" }, { theme }));
      const accent = asRole(resolveStyle({ role: "accent" }, { theme }));
      const muted = asRole(resolveStyle({ role: "muted" }, { theme }));
      const w = Math.min(48, ctx.cols);
      if (ctx.sample % 2 === 1) {
        return {
          type: "box",
          style: { padding: 1, width: w },
          children: [
            Text("content · selected (washes)", {
              userSelect: "text",
              style: { ...fg, selected: true },
            }),
            Text("chrome · userSelect none (no wash)", {
              userSelect: "none",
              style: { role: "chrome" },
            }),
            Text("sidebar chrome never lights — drag the stage", {
              style: muted,
            }),
          ],
        };
      }
      return {
        type: "box",
        style: { padding: 1, width: w },
        children: [
          Text("plain run — identity", { style: fg }),
          Text("selected run — same role", {
            style: { ...fg, selected: true },
          }),
          Text("selected accent — still accent", {
            style: { ...accent, selected: true },
          }),
          Text("wash is accent-hued fill, not inverted FG/BG", {
            style: muted,
          }),
        ],
      };
    },
  },
];
