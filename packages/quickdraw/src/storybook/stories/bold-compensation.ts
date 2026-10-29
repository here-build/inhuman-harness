/**
 * Bold H-K compensation story (color-hygiene plan, enabler 7 / G10) — bold
 * vs non-bold per role at two grounds, side by side, so
 * `BOLD_AL_COMPENSATION` (resolver.ts) can be eyeball-tuned against the
 * contrast-floor suite instead of only trusted from the AL math. Signal
 * "bold reads as weight, not an accent bump" is exactly what this renders:
 * a matching pair per role should look like the same color at heavier
 * weight, never a brighter/different hue.
 *
 * Dual-ground samples bake against `buildTheme({ ground })` then pass
 * **fgRgb + bold SGR**. Bold H-K runs only on the role path at resolve time
 * (not on literal fgRgb), so paintFrame does not double-compensate. Panel
 * fill is elevation furniture — bold never moves it (resolver FG-only law).
 */

import { Panel } from "./demo-atoms.js";
import { type SemanticRole } from "../../lexicon/index.js";
import { BOLD_AL_COMPENSATION, buildTheme, resolveStyle } from "../../theme/index.js";
import { Text } from "../../widgets/index.js";
import type { Story } from "../types.js";

/** Roles worth eyeballing: alarm-tier (G10 rows) plus a baseline voice role. */
const SAMPLE_ROLES: readonly SemanticRole[] = ["foreground", "accent", "error", "diff_del"];

/** Two grounds — dark and light polarity, matching the contrast-floor rows. */
const SAMPLE_GROUNDS: readonly number[] = [0.1, 0.9];

export const BOLD_COMPENSATION_STORIES: Story[] = [
  {
    id: "theme-bold-compensation",
    name: "Bold H-K compensation",
    category: "theme",
    family: "bold",
    description: "Bold vs plain per role at two grounds (0.1 dark / 0.9 light) — eyeball-tune BOLD_AL_COMPENSATION",
    sampleCount: SAMPLE_GROUNDS.length,
    build: (ctx) => {
      const ground = SAMPLE_GROUNDS[ctx.sample % SAMPLE_GROUNDS.length]!;
      const theme = buildTheme({
        ground,
        id: `bold-compensation-${ctx.sample % SAMPLE_GROUNDS.length}`,
        name: `bold-compensation L=${ground.toFixed(2)}`,
      });
      // Role-path resolve once per sample ground. Emit as fgRgb so the host's
      // paintTheme (different ground) does not re-solve roles; bold SGR still
      // paints weight. Resolver does not re-compensate literal fgRgb.
      const muted = resolveStyle({ role: "muted" }, { theme, depth: "truecolor" });

      const lines = SAMPLE_ROLES.flatMap((role) => {
        const plain = resolveStyle({ role, prominence: 1 }, { theme, depth: "truecolor" });
        const bold = resolveStyle({ role, prominence: 1, bold: true }, { theme, depth: "truecolor" });
        return [
          Text(`${role.padEnd(10)} plain  ████████ sample text`, {
            key: `bc:${role}:plain`,
            style: { fgRgb: plain.fgRgb },
            whiteSpace: "nowrap",
          }),
          Text(`${role.padEnd(10)} bold   ████████ sample text`, {
            key: `bc:${role}:bold`,
            // Compensated triple baked; bold:true is SGR weight only.
            style: { fgRgb: bold.fgRgb, bold: true },
            whiteSpace: "nowrap",
          }),
        ];
      });

      return Panel(
        [
          Text(`ground L=${ground.toFixed(2)} · BOLD_AL_COMPENSATION=${BOLD_AL_COMPENSATION} · FG-only`, {
            style: { fgRgb: muted.fgRgb, bold: true },
            whiteSpace: "nowrap",
          }),
          Text("plain/bold pairs should read as same hue, heavier weight —", {
            style: { fgRgb: muted.fgRgb },
            whiteSpace: "nowrap",
          }),
          Text("never a brighter accent bump. Panel fill ignores bold.", {
            style: { fgRgb: muted.fgRgb },
            whiteSpace: "nowrap",
          }),
          ...lines,
        ],
        {
          title: "bold-compensation",
          width: Math.min(56, ctx.cols),
          height: Math.min(lines.length + 6, Math.max(16, ctx.rows)),
        },
      );
    },
  },
];
