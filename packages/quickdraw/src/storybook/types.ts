import type { LayoutNode } from "../layout/index.js";

export type StoryCtx = {
  cols: number;
  rows: number;
  /** animation phase (braille, ink word reveal, etc.) */
  tick: number;
  /** multi-sample stories */
  sample: number;
  /** Wall clock for live labels / birth (ms). */
  nowMs?: number;
};

/**
 * Pipeline chapters — `src/` seams, not content types.
 * Walk order: theme → layout → widgets → expand → buffer → fx.
 */
export const STORY_CHAPTERS = ["theme", "layout", "widgets", "expand", "buffer", "fx"] as const;

export type StoryChapter = (typeof STORY_CHAPTERS)[number];

/** Sidebar nest under a chapter. Variants are `sample`/`tick`, not families. */
export type StoryFamily =
  | "lineup"
  | "attune"
  | "depth"
  | "region"
  | "bold"
  | "selection"
  | "flex"
  | "indication"
  | "grid"
  | "viewport"
  | "disclosure"
  | "text"
  | "atoms"
  | "chrome"
  | "thinking"
  | "speech"
  | "shadow"
  | "wire"
  | "priors"
  | "markdown"
  | "syntax"
  | "guard"
  | "inherit"
  | "measure"
  | "damage"
  | "canary"
  | "select";

export const STORY_FAMILY_ORDER: Record<StoryChapter, readonly StoryFamily[]> = {
  theme: ["region", "selection", "lineup", "attune", "depth", "bold"],
  layout: ["indication", "viewport", "disclosure", "select", "grid", "text", "flex"],
  widgets: ["chrome", "shadow", "wire", "thinking", "speech", "priors", "atoms"],
  expand: ["markdown", "syntax"],
  buffer: ["guard", "inherit", "measure", "damage"],
  fx: ["canary"],
};

/** Retired category tags → how `STORYBOOK_VISUAL_CATEGORY` still filters. */
export const STORY_CHAPTER_ALIASES: Record<string, StoryChapter> = {
  markdown: "expand",
  highlight: "expand",
  diff: "widgets",
  paint: "buffer",
};

export function isStoryChapter(value: string): value is StoryChapter {
  return (STORY_CHAPTERS as readonly string[]).includes(value);
}

export type Story = {
  id: string;
  name: string;
  /** Pipeline chapter (was a pile of content-type tags). */
  category: StoryChapter;
  /** Optional nest under the chapter. */
  family?: StoryFamily;
  description: string;
  /**
   * When true, storybook present re-emits every tick without requiring a
   * TEA model change — buffer `materializeBgFx` drives animation.
   */
  liveFx?: boolean;
  /** Shadertoy catalog id (`gradient` / `aurora` / `doom`). Worker hosts one source. */
  fxId?: string;
  /**
   * Opacity wavefront present path: ink advances on a content clock via
   * `ctx.tick` (structure). Wavefront W steps every present frame at paint
   * — same Frame, no layout. Distinct from liveFx (buffer-only materialize).
   */
  liveBirth?: boolean;
  /**
   * Discrete `ctx.sample` axis for interactive ←/→ and for the visual golden
   * matrix. Default **1** (only sample 0). Stories that index `ctx.sample % N`
   * must set this to N so every meaningful state is photographed.
   */
  sampleCount?: number;
  /**
   * Discrete `ctx.tick` snapshots for goldens (braille, liveFx, etc.).
   * Default **[0]**. liveFx / animated stories should list the ticks that
   * change the painted cells (not every frame — just representative phases).
   */
  tickSnapshots?: readonly number[];
  build: (ctx: StoryCtx) => LayoutNode;
};

/** One cell in the golden matrix: story × sample × tick. */
export type GoldenState = {
  /** Stable slug used as step name + PNG basename. */
  name: string;
  storyId: string;
  sample: number;
  tick: number;
  category: Story["category"];
};
