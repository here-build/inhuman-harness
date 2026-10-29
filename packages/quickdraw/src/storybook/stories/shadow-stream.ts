/**
 * ShadowStream stories — live opacity-peek window.
 *
 * Sample axis: collapsed / peek overlay / peek squeeze / expanded / searching.
 * Live birth: ink words advance on a content clock (`ctx.tick`);
 * wavefront W is host-stepped at paint (not baked into the tree).
 */

import { ShadowStream, Text, ThinkingStream } from "../../widgets/index.js";
import type { Story } from "../types.js";
import { Panel } from "./demo-atoms.js";

/** Panel furniture — ShadowStream must dissolve into *this*, not theme ground.
 * 0.85 = BgP.panel (avoid storybook → lexicon dep; same ladder step). */
const PANEL_SURFACE = {
  surfaceRole: "surface" as const,
  surfaceProminence: 0.85,
};

/** Script words — revealed by tick for the live peek sample. */
const SCRIPT = [
  "User",
  "told",
  "me",
  "to",
  "refactor",
  "the",
  "failing",
  "suite",
  "so",
  "I",
  "should",
  "first",
  "locate",
  "the",
  "flaky",
  "test",
  "then",
  "isolate",
  "the",
  "shared",
  "state",
  "it",
  "leaks",
  "then",
  "add",
  "a",
  "regression",
  "that",
  "pins",
  "the",
  "row",
  "before",
  "I",
  "touch",
  "the",
  "fix",
];

const WORDS_PER_LINE = 6;

/** Build stream text from tick: one word per tick, line break every N. */
/**
 * Build stream text from tick.
 * Host content clock should pause at `SCRIPT.length` (full) then restart —
 * do not `%` here (outer modulo was truncating the intended end-pause).
 */
export function streamText(tick: number): string {
  const n = Math.max(0, Math.min(tick, SCRIPT.length));
  const words = SCRIPT.slice(0, n);
  if (words.length === 0) return "";
  const lines: string[] = [];
  for (let i = 0; i < words.length; i += WORDS_PER_LINE) {
    lines.push(words.slice(i, i + WORDS_PER_LINE).join(" "));
  }
  return lines.join("\n");
}

/** Word count — storybook inkPhase uses this for grow/hold cycle. */
export const SHADOW_STREAM_SCRIPT_LEN = SCRIPT.length;

/** Static multi-line body that fills the peek window (squeeze demo). */
const SQUEEZE_BODY = [
  "oldest line dissolving into the primitive row",
  "middle of the peek window by age",
  "newest premise at full base prominence",
].join("\n");

export const SHADOW_STREAM_STORIES: Story[] = [
  {
    id: "w-shadow-stream-states",
    name: "ShadowStream · states",
    category: "widgets",
    family: "shadow",
    description: "collapsed / peek overlay / peek squeeze / expanded / searching — fade toward local surface",
    sampleCount: 5,
    build: (ctx) => {
      const poses = [
        {
          label: "fully_collapsed · primitive only",
          state: "fully_collapsed" as const,
          primitive: "thinking",
          lines: SQUEEZE_BODY,
        },
        {
          label: "peek · one line (ghost overlay from first ink)",
          state: "peek" as const,
          primitive: "thinking",
          lines: "newest premise at full base prominence",
        },
        {
          label: "peek · squeeze · dissolve into panel surface",
          state: "peek" as const,
          primitive: "thinking",
          lines: SQUEEZE_BODY,
        },
        {
          label: "expanded · full lines at base",
          state: "expanded" as const,
          primitive: "thinking",
          lines: SQUEEZE_BODY,
        },
        {
          label: "searching · not a thinking feature",
          state: "peek" as const,
          primitive: "searching",
          lines: SQUEEZE_BODY,
        },
      ];
      const pose = poses[ctx.sample % poses.length]!;
      const w = Math.min(48, Math.max(24, ctx.cols - 4));
      return Panel(
        [
          Text(`${pose.label}  ·  ←/→ sample`, {
            style: { role: "muted", prominence: 0.42 },
            whiteSpace: "nowrap",
          }),
          Text("opacity = prominence → local surface (BgP.panel), not CSS alpha", {
            style: { role: "muted", prominence: 0.28 },
            whiteSpace: "nowrap",
          }),
          ShadowStream({
            key: "ss-states",
            primitive: pose.primitive,
            lines: pose.lines,
            state: pose.state,
            width: w,
            height: 3,
            ...PANEL_SURFACE,
          }),
        ],
        {
          title: "shadow-stream",
          width: Math.min(w + 4, ctx.cols),
          height: Math.min(12, ctx.rows),
        },
      );
    },
  },
  {
    id: "w-shadow-stream-live",
    name: "ShadowStream · wavefront",
    category: "widgets",
    family: "shadow",
    description: "opacity wavefront W crawls on present FPS — ink on content clock, not a typewriter",
    liveBirth: true,
    /** Enough ticks to cross into squeeze (height 3 lines × ~6 words). */
    tickSnapshots: [0, 4, 12, 20, 28],
    build: (ctx) => {
      const w = Math.min(48, Math.max(24, ctx.cols - 4));
      const text = streamText(ctx.tick);
      const lineCount = text ? text.split("\n").length : 0;
      const regime = lineCount === 0 ? "empty" : lineCount < 3 ? "overlay" : "squeeze";
      return Panel(
        [
          Text(`ink=${ctx.tick}  ·  ${regime}  ·  wavefront@present`, {
            style: { role: "muted", prominence: 0.42 },
            whiteSpace: "nowrap",
          }),
          ShadowStream({
            key: "ss-live",
            primitive: "thinking",
            lines: text,
            state: "peek",
            width: w,
            height: 3,
            wavefront: true,
            ...PANEL_SURFACE,
          }),
        ],
        {
          title: "shadow-stream live",
          width: Math.min(w + 4, ctx.cols),
          height: Math.min(12, ctx.rows),
        },
      );
    },
  },
  {
    id: "w-shadow-stream-thinking",
    name: "ShadowStream · ThinkingStream wire",
    category: "widgets",
    family: "wire",
    description: "ThinkingStream live+collapsed: present-stepped opacity wavefront under spinner",
    liveBirth: true,
    tickSnapshots: [0, 6, 14, 22],
    build: (ctx) => {
      const w = Math.min(40, Math.max(20, ctx.cols - 4));
      return ThinkingStream(
        {
          text: streamText(Math.max(ctx.tick, 8)),
          live: true,
          collapsed: true,
          seal: "live",
          durationMs: 1200 + ctx.tick * 80,
          peekLines: 3,
          shadowState: "peek",
          wavefront: true,
          // Transparent transcript: no surfaceRole → theme ground is correct.
        },
        { key: "th-shadow", width: w },
      );
    },
  },
];
