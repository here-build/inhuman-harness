/**
 * One-shot present. Stdin is a single JSON object (no length prefix).
 * Stdout is a dump. The release binary reads stdin until EOF.
 */
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { getSnapshot } from "mobx-state-tree";

import type { Tea } from "../tea.js";

export const PRESENT_NOW_MS = 1_700_000_000_000;

export type Ink = "primary" | "secondary" | "rising" | "ghost" | "whisper";

export type Run = {
  y: number;
  x: number;
  text: string;
  role: string;
  ink: Ink;
  dim: boolean;
};

/** Resolved background span. Eyes only. Not part of the phase assertion. */
export type Fill = {
  y: number;
  x: number;
  w: number;
  bg: string;
};

/** Resolved foreground span. Eyes only. Not part of the phase assertion. */
export type InkRun = {
  y: number;
  x: number;
  text: string;
  fg: string;
};

export type Posted = {
  kind: string;
  key?: string;
  delta?: number;
  cols?: number;
  rows?: number;
};

export type Dump = {
  posted: Posted[];
  runs: Run[];
  fills: Fill[];
  inks: InkRun[];
};

export type DumpOpts = {
  input?: string[];
  cols?: number;
  rows?: number;
  nowMs?: number;
};

const presentDir = dirname(fileURLToPath(import.meta.url));
const RELEASE_QD = join(presentDir, "../../../../quickdraw/rust/qd/target/release/qd");
const STDOUT_CAP = 32 * 1024 * 1024;

function qdBin(): string {
  const override = process.env.QD_BIN;
  if (override !== undefined && override !== "") return resolve(override);
  return RELEASE_QD;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInk(value: unknown): value is Ink {
  return value === "primary" || value === "secondary" || value === "rising" || value === "ghost" || value === "whisper";
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isOptionalNumber(value: unknown): boolean {
  return value === undefined || typeof value === "number";
}

function isArrayOf<T>(value: unknown, item: (value: unknown) => value is T): value is T[] {
  if (!Array.isArray(value)) return false;
  for (const entry of value) {
    if (!item(entry)) return false;
  }
  return true;
}

function isPosted(value: unknown): value is Posted {
  if (!isRecord(value)) return false;
  return (
    typeof value.kind === "string" &&
    isOptionalString(value.key) &&
    isOptionalNumber(value.delta) &&
    isOptionalNumber(value.cols) &&
    isOptionalNumber(value.rows)
  );
}

function isRun(value: unknown): value is Run {
  if (!isRecord(value)) return false;
  return (
    typeof value.y === "number" &&
    typeof value.x === "number" &&
    typeof value.text === "string" &&
    typeof value.role === "string" &&
    isInk(value.ink) &&
    typeof value.dim === "boolean"
  );
}

function isHex(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== 7 || value.charAt(0) !== "#") return false;
  for (const ch of value.slice(1)) {
    const digit = (ch >= "0" && ch <= "9") || (ch >= "a" && ch <= "f");
    if (!digit) return false;
  }
  return true;
}

function isFill(value: unknown): value is Fill {
  if (!isRecord(value)) return false;
  return typeof value.y === "number" && typeof value.x === "number" && typeof value.w === "number" && isHex(value.bg);
}

function isInkRun(value: unknown): value is InkRun {
  if (!isRecord(value)) return false;
  return (
    typeof value.y === "number" && typeof value.x === "number" && typeof value.text === "string" && isHex(value.fg)
  );
}

function pictureOf<T>(value: unknown, item: (value: unknown) => value is T, label: string): T[] {
  if (value === undefined) return [];
  if (!isArrayOf(value, item)) throw new Error(`${label} is not a list`);
  return value;
}

function clip(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= 400) return trimmed;
  return `${trimmed.slice(0, 400)}…`;
}

export function parseDump(text: string, label: string): Dump {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid json";
    throw new Error(`${label} is not json: ${detail}`, { cause: error });
  }
  if (!isRecord(parsed) || !isArrayOf(parsed.posted, isPosted) || !isArrayOf(parsed.runs, isRun)) {
    throw new Error(`${label} is not a dump: ${clip(text)}`);
  }
  return {
    posted: parsed.posted,
    runs: parsed.runs,
    fills: pictureOf(parsed.fills, isFill, `${label} fills`),
    inks: pictureOf(parsed.inks, isInkRun, `${label} inks`),
  };
}

function exitHow(status: number | null, signal: NodeJS.Signals | null): string {
  if (status === null) return `signal ${signal ?? "unknown"}`;
  return `exit ${status}`;
}

export async function presentDump(tea: Tea, opts?: DumpOpts): Promise<Dump> {
  tea.flushPaint();
  const bin = qdBin();
  const input = JSON.stringify({
    cols: opts?.cols ?? tea.cols,
    rows: opts?.rows ?? tea.rows,
    nowMs: opts?.nowMs ?? PRESENT_NOW_MS,
    paint: JSON.stringify({
      kind: "paint_init",
      epoch: "visual",
      snapshot: getSnapshot(tea.paintRoot),
    }),
    input: opts?.input ?? [],
  });
  const child = spawnSync(bin, ["dump"], {
    input,
    encoding: "utf8",
    maxBuffer: STDOUT_CAP,
  });
  if (child.error) throw new Error(`qd dump failed (${bin}): ${child.error.message}`);
  if (child.status !== 0) {
    const stderr = child.stderr.trim();
    const tail = stderr === "" ? "" : `\n${stderr}`;
    throw new Error(`qd dump ${exitHow(child.status, child.signal)} (${bin})${tail}`);
  }
  return parseDump(child.stdout, "qd dump stdout");
}
