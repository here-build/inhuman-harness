/**
 * Story catalog SSOT — pipeline order.
 *
 * theme → layout → widgets → expand → buffer → fx
 */

import { BOLD_COMPENSATION_STORIES } from "./stories/bold-compensation.js";
import { PAINT_STORIES } from "./stories/buffer.js";
import { DIFF_STORIES } from "./stories/diff.js";
import { MARKDOWN_STORIES } from "./stories/expand/markdown.js";
import { HIGHLIGHT_STORIES } from "./stories/expand/syntax.js";
import { FX_STORIES } from "./stories/fx.js";
import { LAYOUT_STORIES } from "./stories/layout.js";
import { SELECT_STORIES } from "./stories/select.js";
import { SHADOW_STREAM_STORIES } from "./stories/shadow-stream.js";
import { THEME_STORIES } from "./stories/theme.js";
import { WIDGET_STORIES } from "./stories/widgets.js";
import {
  STORY_CHAPTERS,
  STORY_CHAPTER_ALIASES,
  STORY_FAMILY_ORDER,
  isStoryChapter,
  type Story,
  type StoryChapter,
  type StoryFamily,
} from "./types.js";

function chapterIndex(chapter: string): number {
  const i = STORY_CHAPTERS.indexOf(chapter as StoryChapter);
  return i === -1 ? STORY_CHAPTERS.length : i;
}

function familyIndex(chapter: string, family?: string): number {
  if (!isStoryChapter(chapter)) return 0;
  const list = STORY_FAMILY_ORDER[chapter];
  if (!family) return list.length;
  const i = list.indexOf(family as StoryFamily);
  return i === -1 ? list.length : i;
}

export function compareStories(a: Story, b: Story): number {
  const ch = chapterIndex(a.category) - chapterIndex(b.category);
  if (ch !== 0) return ch;
  const fam = familyIndex(a.category, a.family) - familyIndex(b.category, b.family);
  if (fam !== 0) return fam;
  return a.id.localeCompare(b.id);
}

export const CATALOG: Story[] = [
  ...WIDGET_STORIES,
  ...LAYOUT_STORIES,
  ...MARKDOWN_STORIES,
  ...HIGHLIGHT_STORIES,
  ...DIFF_STORIES,
  ...THEME_STORIES,
  ...BOLD_COMPENSATION_STORIES,
  ...SHADOW_STREAM_STORIES,
  ...PAINT_STORIES,
  ...SELECT_STORIES,
  ...FX_STORIES,
].sort(compareStories);

export function getStory(id: string): Story | undefined {
  return CATALOG.find((s) => s.id === id);
}

export function filterCatalog(q: string): Story[] {
  const s = q.trim().toLowerCase();
  if (!s) return CATALOG;
  const aliased = STORY_CHAPTER_ALIASES[s];
  return CATALOG.filter((c) => {
    if (c.id.includes(s) || c.name.toLowerCase().includes(s)) return true;
    if (c.category.includes(s) || (aliased && c.category === aliased)) return true;
    if (c.family?.includes(s)) return true;
    if (c.description.toLowerCase().includes(s)) return true;
    return false;
  });
}
