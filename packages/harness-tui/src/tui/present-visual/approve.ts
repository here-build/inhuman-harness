/**
 * Phase oracle for the Rust present dump. JSON is the assertion.
 * A review PNG and the actual dump are written only when that assertion fails.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Tea } from "../tea.js";
import { parseDump, presentDump, type Dump, type DumpOpts, type Posted, type Run } from "./dump.js";
import { noteBeat } from "./journey.js";
import { writeRunsPng } from "./raster.js";

export type { DumpOpts } from "./dump.js";

export type Law = {
  posted?: Posted[];
  runs: Array<Pick<Run, "text"> & Partial<Pick<Run, "role" | "ink" | "dim" | "y">>>;
};

type LawRun = Law["runs"][number];

type ExpectFn = (actual: unknown, message?: string) => { toEqual(expected: unknown): void };

const PHASE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const presentDir = dirname(fileURLToPath(import.meta.url));
const phasesDir = join(presentDir, "phases");
const diffDir = join(presentDir, "__diff__");

function assertPhaseName(name: string): void {
  if (!PHASE_NAME.test(name)) {
    throw new Error(`phase name must be kebab-case, got ${JSON.stringify(name)}`);
  }
}

function phasePath(name: string): string {
  return join(phasesDir, `${name}.json`);
}

function frameSize(tea: Tea, opts: DumpOpts | undefined): { cols: number; rows: number } {
  return { cols: opts?.cols ?? tea.cols, rows: opts?.rows ?? tea.rows };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPhase(name: string): Dump {
  return parseDump(readFileSync(phasePath(name), "utf8"), `phase ${name}`);
}

/** Phase files lock runs. Resolved fills and inks stay on the picture. */
function asserted(dump: Dump): Pick<Dump, "posted" | "runs"> {
  return {
    posted: dump.posted,
    runs: dump.runs.map((run) => ({
      y: run.y,
      x: run.x,
      text: run.text,
      role: run.role,
      ink: run.ink,
      dim: run.dim,
    })),
  };
}

function recordPhase(name: string, dump: Dump): void {
  const file = phasePath(name);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(asserted(dump), null, 2)}\n`);
}

async function writeReview(
  name: string,
  cols: number,
  rows: number,
  actual: Dump,
  expected: Dump | undefined,
): Promise<string[]> {
  const actualPath = join(diffDir, `${name}-actual.png`);
  const actualJson = join(diffDir, `${name}-actual.json`);
  const written = [actualJson, actualPath];
  mkdirSync(diffDir, { recursive: true });
  writeFileSync(actualJson, `${JSON.stringify(asserted(actual), null, 2)}\n`);
  await writeRunsPng(actualPath, actual, cols, rows);
  if (expected !== undefined) {
    const expectedPath = join(diffDir, `${name}-expected.png`);
    written.push(expectedPath);
    await writeRunsPng(expectedPath, expected, cols, rows);
  }
  return written;
}

async function attachReview(
  error: unknown,
  name: string,
  cols: number,
  rows: number,
  actual: Dump,
  expected: Dump | undefined,
): Promise<void> {
  let note = "";
  try {
    const paths = await writeReview(name, cols, rows, actual, expected);
    note = `\n${paths.join("\n")}`;
  } catch (pngError) {
    const detail = pngError instanceof Error ? pngError.message : "review png failed";
    note = `\nreview png failed: ${detail}`;
  }
  if (error instanceof Error && note !== "") error.message += note;
}

function isExpectFn(value: unknown): value is ExpectFn {
  return typeof value === "function";
}

async function assertEqual(actual: unknown, expected: unknown, message: string): Promise<void> {
  // This file is production to the boundary gate. vitest is a devDependency,
  // so a string-literal import is rejected. Tests call this from the runner.
  const spec = "vitest";
  const loaded: unknown = await import(spec);
  if (!isRecord(loaded) || !isExpectFn(loaded.expect)) throw new Error("vitest expect is unavailable");
  loaded.expect(actual, message).toEqual(expected);
}

async function settle(
  error: unknown,
  name: string,
  cols: number,
  rows: number,
  actual: Dump,
  expected: Dump | undefined,
): Promise<never> {
  await attachReview(error, name, cols, rows, actual, expected);
  throw error;
}

function runMatches(actual: Run, wanted: LawRun): boolean {
  if (!actual.text.includes(wanted.text)) return false;
  if (wanted.role !== undefined && actual.role !== wanted.role) return false;
  if (wanted.ink !== undefined && actual.ink !== wanted.ink) return false;
  if (wanted.dim !== undefined && actual.dim !== wanted.dim) return false;
  if (wanted.y !== undefined && actual.y !== wanted.y) return false;
  return true;
}

export async function approve(name: string, tea: Tea, opts?: DumpOpts): Promise<void> {
  assertPhaseName(name);
  const record = process.env.RECORD_PRESENT === "1";
  if (!record && !existsSync(phasePath(name))) throw new Error(`missing phase ${name}`);
  const expected = record ? undefined : readPhase(name);
  const { cols, rows } = frameSize(tea, opts);
  const actual = await presentDump(tea, { ...opts, cols, rows });
  if (expected === undefined) {
    recordPhase(name, actual);
    await noteBeat(name, actual, cols, rows, true, []);
    return;
  }
  try {
    await assertEqual(asserted(actual), asserted(expected), `phase ${name}`);
  } catch (error) {
    await noteBeat(name, actual, cols, rows, false, ["frame diverged from the recorded phase"]);
    await settle(error, name, cols, rows, actual, expected);
  }
  await noteBeat(name, actual, cols, rows, true, []);
}

export async function approveLaw(name: string, tea: Tea, law: Law, opts?: DumpOpts): Promise<void> {
  assertPhaseName(name);
  const { cols, rows } = frameSize(tea, opts);
  const actual = await presentDump(tea, { ...opts, cols, rows });
  const missed = law.runs.filter((wanted) => !actual.runs.some((run) => runMatches(run, wanted)));
  const missedNotes = missed.map((wanted) => {
    const bits = [wanted.text];
    if (wanted.role !== undefined) bits.push(wanted.role);
    if (wanted.ink !== undefined) bits.push(wanted.ink);
    if (wanted.dim !== undefined) bits.push(wanted.dim ? "dim" : "bright");
    return bits.join(" · ");
  });
  const postedWanted = law.posted ?? actual.posted;
  if (JSON.stringify(actual.posted) !== JSON.stringify(postedWanted)) missedNotes.push("posted");
  try {
    await assertEqual({ missed, posted: actual.posted }, { missed: [], posted: postedWanted }, `phase ${name}`);
  } catch (error) {
    await noteBeat(name, actual, cols, rows, false, missedNotes);
    await settle(error, name, cols, rows, actual, undefined);
  }
  await noteBeat(name, actual, cols, rows, true, []);
}
