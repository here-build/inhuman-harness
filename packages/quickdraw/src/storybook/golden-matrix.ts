/**
 * Programmatic golden matrix: every story × every sample × every tick snapshot.
 *
 * Visual suite and story-demo speak this slug:
 *   `{storyId}__s{sample}__t{tick}`
 */

import { type GoldenState, type Story, STORY_CHAPTER_ALIASES } from "./types.js";

/** Parse a matrix slug; plain story id → sample 0 / tick 0. */
export function parseGoldenSlug(slug: string): { storyId: string; sample: number; tick: number } | null {
  const m = /^(.*)__s(\d+)__t(\d+)$/.exec(slug);
  if (m) {
    return {
      storyId: m[1]!,
      sample: Number(m[2]),
      tick: Number(m[3]),
    };
  }
  // bare id (interactive)
  if (slug.length > 0 && !slug.includes("__")) {
    return { storyId: slug, sample: 0, tick: 0 };
  }
  return null;
}

export function goldenSlug(storyId: string, sample: number, tick: number): string {
  return `${storyId}__s${sample}__t${tick}`;
}

export function storySampleCount(s: Story): number {
  const n = s.sampleCount ?? 1;
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

export function storyTickSnapshots(s: Story): readonly number[] {
  if (s.tickSnapshots && s.tickSnapshots.length > 0) {
    return s.tickSnapshots;
  }
  // liveFx without explicit ticks: two representative phases
  if (s.liveFx) return [0, 5];
  return [0];
}

/**
 * Expand stories into the full golden matrix (cartesian product).
 * Order: catalog order, then sample asc, then tick asc.
 */
export function expandGoldenMatrix(stories: readonly Story[]): GoldenState[] {
  const out: GoldenState[] = [];
  for (const s of stories) {
    const samples = storySampleCount(s);
    const ticks = storyTickSnapshots(s);
    for (let sample = 0; sample < samples; sample++) {
      for (const tick of ticks) {
        out.push({
          name: goldenSlug(s.id, sample, tick),
          storyId: s.id,
          sample,
          tick,
          category: s.category,
        });
      }
    }
  }
  return out;
}

export type GoldenMatrixFilter = {
  /** Substring or regex source matched against story id. */
  story?: string;
  /** Chapter equality, or a retired tag (`markdown` / `highlight` / `diff` / `paint`). */
  category?: string;
};

export function filterGoldenMatrix(states: readonly GoldenState[], f: GoldenMatrixFilter): GoldenState[] {
  let out = [...states];
  if (f.category) {
    const raw = f.category;
    out = out.filter((s) => {
      if (s.category === raw) return true;
      if (raw === "markdown") return s.storyId.startsWith("md-");
      if (raw === "highlight") return s.storyId.startsWith("hl-");
      if (raw === "diff") return s.storyId.startsWith("diff-");
      if (raw === "paint") {
        return s.category === "buffer" || s.storyId.startsWith("paint-");
      }
      const aliased = STORY_CHAPTER_ALIASES[raw];
      return aliased != null && s.category === aliased;
    });
  }
  if (f.story) {
    try {
      const re = new RegExp(f.story, "i");
      out = out.filter((s) => re.test(s.storyId) || re.test(s.name));
    } catch {
      const q = f.story.toLowerCase();
      out = out.filter((s) => s.storyId.toLowerCase().includes(q) || s.name.toLowerCase().includes(q));
    }
  }
  return out;
}

/** Env-driven filter for visual / CLI runners. */
export function goldenMatrixFilterFromEnv(env: NodeJS.ProcessEnv = process.env): GoldenMatrixFilter {
  const f: GoldenMatrixFilter = {};
  const story = env["STORYBOOK_VISUAL_STORY"]?.trim();
  if (story) f.story = story;
  const category = env["STORYBOOK_VISUAL_CATEGORY"]?.trim();
  if (category) f.category = category;
  return f;
}
