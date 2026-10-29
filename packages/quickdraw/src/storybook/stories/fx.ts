/**
 * Procedural background stories — GLSL catalog registered by the host.
 * Full interactive pool (split / opacity HUD): `pnpm --filter @inhuman.tools/quickdraw fx`
 */

import { getBgFxOpacity, setBgFxOpacity } from "../../internals/bgfx/index.js";
import { quarantine } from "../../lexicon/index.js";
import { Text } from "../../widgets/index.js";
import type { Story } from "../types.js";

const FX_POOL = [
  { id: "gradient", name: "Gradient wash" },
  { id: "aurora", name: "Aurora" },
  { id: "doom", name: "Doom" },
] as const;

function fxStory(id: (typeof FX_POOL)[number]["id"], name: string): Story {
  return {
    id: `fx-${id}`,
    name,
    category: "fx",
    family: "canary",
    fxId: id,
    description: `canary · bgFx:${id} · not product chrome (register catalog first)`,
    liveFx: true,
    sampleCount: 5,
    tickSnapshots: [0, 5],
    build: (ctx) => {
      const op = 0.12 + (ctx.sample % 5) * 0.12;
      setBgFxOpacity(op);
      return {
        type: "box",
        style: {
          width: ctx.cols,
          height: ctx.rows,
          background: { bgFx: id },
          padding: 1,
        },
        children: [
          // Demo-only HUD over an arbitrary field — no role/prominence
          // answer yet; quarantined as artwork (post-audit G9).
          Text(`${id} · α=${getBgFxOpacity().toFixed(2)} · ←/→ sample · needs GLSL catalog`, {
            style: {
              bold: true,
              fgRgb: quarantine({ r: 220, g: 220, b: 230 }, "artwork"),
            },
          }),
          Text("bg only · shader catalog (no CPU mesh)", {
            style: {
              fgRgb: quarantine({ r: 160, g: 160, b: 175 }, "artwork"),
            },
          }),
        ],
      };
    },
  };
}

export const FX_STORIES: Story[] = FX_POOL.map((e) => fxStory(e.id, e.name));
