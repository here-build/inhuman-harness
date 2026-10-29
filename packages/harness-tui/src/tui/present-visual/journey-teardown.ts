/**
 * Writes journey/index.html after the visual project finishes.
 * Each test file is one strip. Frames stay in the order the file ran them.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { journeyDir } from "./journey.js";

type BeatNote = {
  order: number;
  phase: string;
  title: string;
  ok: boolean;
  missed: string[];
  png: string;
};

const STORY_ORDER = [
  "omnibox",
  "tape",
  "work",
  "agents",
  "rewind",
  "catalog-frames",
  "catalog-shell",
  "catalog-scheme",
  "catalog-observe",
  "catalog-mutate",
  "catalog-foreign",
  "catalog-license",
  "catalog-rewind",
  "catalog-compact",
  "catalog-tape-fuse",
];

const STORY_LABEL: Record<string, string> = {
  omnibox: "Omnibox",
  tape: "Tape",
  work: "Work",
  agents: "Agents",
  rewind: "Rewind",
  "catalog-frames": "Frames",
  "catalog-shell": "Shell",
  "catalog-scheme": "Scheme",
  "catalog-observe": "Observe",
  "catalog-mutate": "Mutate",
  "catalog-foreign": "Foreign",
  "catalog-license": "License",
  "catalog-rewind": "Rewind steps",
  "catalog-compact": "Compact",
  "catalog-tape-fuse": "Tape fuse",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readBeat(file: string): BeatNote | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const { order, phase, title, ok, missed, png } = parsed;
  if (typeof order !== "number" || typeof phase !== "string" || typeof title !== "string") return undefined;
  if (typeof ok !== "boolean" || typeof png !== "string" || !Array.isArray(missed)) return undefined;
  const lines: string[] = [];
  for (const line of missed) {
    if (typeof line !== "string") return undefined;
    lines.push(line);
  }
  return { order, phase, title, ok, missed: lines, png };
}

function storyBeats(story: string): BeatNote[] {
  let names: string[];
  try {
    names = readdirSync(join(journeyDir, story));
  } catch {
    return [];
  }
  const beats: BeatNote[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const beat = readBeat(join(journeyDir, story, name));
    if (beat !== undefined) beats.push(beat);
  }
  beats.sort((a, b) => a.order - b.order);
  return beats;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function beatFigure(story: string, beat: BeatNote): string {
  const klass = beat.ok ? "beat" : "beat gap";
  const mark = beat.ok ? "" : `<p class="mark">open law</p>`;
  const missed =
    beat.missed.length === 0
      ? ""
      : `<ul class="missed">${beat.missed.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul>`;
  const src = `${escapeHtml(story)}/${escapeHtml(beat.png)}`;
  return `<figure class="${klass}">
  <a href="${src}"><img src="${src}" alt="${escapeHtml(beat.title)}"></a>
  <figcaption>
    <p class="title">${escapeHtml(beat.title)}</p>
    <p class="phase">${escapeHtml(beat.phase)}</p>
    ${mark}
    ${missed}
  </figcaption>
</figure>`;
}

function countLabel(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

function storySection(story: string, beats: readonly BeatNote[]): string {
  const label = STORY_LABEL[story] ?? story;
  const open = beats.filter((beat) => !beat.ok).length;
  const frames = countLabel(beats.length, "frame", "frames");
  const laws = countLabel(open, "open law", "open laws");
  const tally = open === 0 ? frames : `${frames} · ${laws}`;
  return `<section id="${escapeHtml(story)}">
  <h2>${escapeHtml(label)}</h2>
  <p class="tally">${tally}</p>
  <div class="strip">${beats.map((beat) => beatFigure(story, beat)).join("\n")}</div>
</section>`;
}

function page(stories: ReadonlyArray<{ story: string; beats: BeatNote[] }>): string {
  const nav = stories
    .map(({ story }) => `<a href="#${escapeHtml(story)}">${escapeHtml(STORY_LABEL[story] ?? story)}</a>`)
    .join("");
  const body = stories.map(({ story, beats }) => storySection(story, beats)).join("\n");
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>qd journeys</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; background: #121212; color: #e6e6e6; font: 15px/1.45 ui-sans-serif, system-ui, sans-serif; }
  header, section { padding: 28px 32px; }
  section { padding-top: 8px; }
  h1 { margin: 0 0 8px; font-size: 22px; font-weight: 600; }
  h2 { margin: 0; font-size: 16px; font-weight: 600; }
  .lede, .tally, .phase { color: #9a9a9a; }
  .lede { max-width: 68ch; margin: 0 0 16px; }
  nav { display: flex; gap: 16px; }
  nav a { color: #d7d7d7; }
  .tally { margin: 4px 0 12px; }
  .strip { display: flex; gap: 20px; overflow-x: auto; align-items: flex-start; padding-bottom: 12px; }
  figure { margin: 0; flex: 0 0 auto; width: min(520px, 78vw); }
  img { width: 100%; height: auto; display: block; background: #1b1b1b; border-radius: 8px; }
  figcaption { margin-top: 8px; }
  .title { margin: 0; font-weight: 600; }
  .phase, .mark { margin: 2px 0 0; }
  .mark { color: #e7a0a0; }
  .gap img { outline: 1px solid #8f4d4d; outline-offset: 2px; }
  .missed { margin: 6px 0 0; padding-left: 18px; color: #bdbdbd; font-family: ui-monospace, monospace; font-size: 12px; }
</style>
<header>
  <h1>qd journeys</h1>
  <p class="lede">Each strip is one test file. Frames stay in the order that file asserts them. A red outline means that frame's law is still open. The assertion stays JSON.</p>
  <nav>${nav}</nav>
</header>
${body}
</html>
`;
}

function orderedStories(): string[] {
  let names: string[];
  try {
    names = readdirSync(journeyDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  const rank = new Map(STORY_ORDER.map((story, index) => [story, index]));
  return names.sort((a, b) => (rank.get(a) ?? 100) - (rank.get(b) ?? 100) || a.localeCompare(b));
}

export function writeJourneyPage(): string {
  const stories = orderedStories()
    .map((story) => ({ story, beats: storyBeats(story) }))
    .filter((entry) => entry.beats.length > 0);
  const file = join(journeyDir, "index.html");
  writeFileSync(file, page(stories));
  return file;
}

export function teardown(): void {
  const file = writeJourneyPage();
  console.log(`journey ${file}`);
}
