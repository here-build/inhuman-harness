/**
 * One frame per asserted beat, grouped by the test file.
 * The page is for eyes. The dump JSON stays the assertion.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Dump } from "./dump.js";
import { writeRunsPng } from "./raster.js";

export type BeatNote = {
  order: number;
  phase: string;
  title: string;
  ok: boolean;
  missed: string[];
  png: string;
};

const presentDir = dirname(fileURLToPath(import.meta.url));
export const journeyDir = join(presentDir, "journey");

const beatCount = new Map<string, number>();
const opened = new Set<string>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type BeatCaller = {
  getState(): unknown;
};

function readState(value: unknown): { testPath: string; title: string } {
  if (!isRecord(value)) return { testPath: "", title: "" };
  return {
    testPath: typeof value.testPath === "string" ? value.testPath : "",
    title: typeof value.currentTestName === "string" ? value.currentTestName : "",
  };
}

function asCaller(value: unknown): BeatCaller | undefined {
  if (typeof value !== "function" || !("getState" in value)) return undefined;
  const getState = value.getState;
  if (typeof getState !== "function") return undefined;
  return { getState: () => getState.call(value) };
}

async function callerBeat(): Promise<{ story: string; title: string }> {
  const spec = "vitest";
  const loaded: unknown = await import(spec);
  const state = readState(asCaller(isRecord(loaded) ? loaded.expect : undefined)?.getState());
  const file = basename(state.testPath);
  const name = file.endsWith(".test.ts") ? file.slice(0, -".test.ts".length) : "beats";
  // The old screenshot walks share basenames with this directory (`rewind`).
  const story = state.testPath.includes("/__visual__/") ? `catalog-${name}` : name;
  return { story, title: state.title };
}

function openStory(story: string): void {
  if (opened.has(story)) return;
  opened.add(story);
  rmSync(join(journeyDir, story), { recursive: true, force: true });
  mkdirSync(join(journeyDir, story), { recursive: true });
}

function reserveBeat(story: string, title: string, phase: string, ok: boolean, missed: readonly string[]): BeatNote {
  openStory(story);
  const order = (beatCount.get(story) ?? 0) + 1;
  beatCount.set(story, order);
  const png = `${String(order).padStart(2, "0")}-${phase}.png`;
  return { order, phase, title: title === "" ? phase : title, ok, missed: [...missed], png };
}

function writeNote(story: string, note: BeatNote): void {
  const json = note.png.endsWith(".png") ? `${note.png.slice(0, -".png".length)}.json` : `${note.png}.json`;
  writeFileSync(join(journeyDir, story, json), `${JSON.stringify(note)}\n`);
}

/** Writes the frame even when the beat fails. A raster error does not replace the assertion. */
export async function noteBeat(
  phase: string,
  dump: Dump,
  cols: number,
  rows: number,
  ok: boolean,
  missed: readonly string[],
): Promise<void> {
  try {
    const caller = await callerBeat();
    const note = reserveBeat(caller.story, caller.title, phase, ok, missed);
    const dir = join(journeyDir, caller.story);
    await writeRunsPng(join(dir, note.png), dump, cols, rows);
    writeNote(caller.story, note);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "journey frame failed";
    console.error(`journey ${phase}: ${detail}`);
  }
}

/** A frame that is already a PNG. Used when the walk painted through the JS raster. */
export async function notePng(phase: string, png: Buffer, ok: boolean, missed: readonly string[]): Promise<void> {
  try {
    const caller = await callerBeat();
    const note = reserveBeat(caller.story, caller.title, phase, ok, missed);
    const dir = join(journeyDir, caller.story);
    writeFileSync(join(dir, note.png), png);
    writeNote(caller.story, note);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "journey frame failed";
    console.error(`journey ${phase}: ${detail}`);
  }
}
