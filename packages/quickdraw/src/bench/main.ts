/**
 * Render thread (main).
 * Spawns logic worker, presents @ targetFps, writes ANSI to stdout.
 */

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import { createFpsTracker, LatestMailbox, type HostToWorker, type WorkerToHost } from "./host.js";
import type { Model } from "./model.js";
import type { Snapshot } from "./tea.js";
import { cloneBuffer, emitAnsi, type Buffer as CellBuffer } from "../buffer/index.js";
import { startPresentLoop } from "../index.js";
import { paint } from "./view.js";

const TARGET_FPS = Number(process.env.QD_FPS ?? 30);
const TICK_MS = Number(process.env.QD_TICK_MS ?? 50); // logic clock / log growth
const SYNC_2026 = process.env.QD_SYNC !== "0";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function termSize(): { cols: number; rows: number } {
  return {
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
  };
}

const mailbox = new LatestMailbox<Model>();
const fps = createFpsTracker();
let prev: CellBuffer | null = null;
let canvas: CellBuffer | undefined;
let lastPaintedGen = -1;
let worker: Worker;

function send(msg: HostToWorker): void {
  worker.postMessage(msg);
}

function setupTerminal(): void {
  process.stdout.write("\u001B[?1049h"); // alt screen
  process.stdout.write("\u001B[?25l"); // hide cursor
  process.stdout.write("\u001B[?7l"); // no wrap
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
  }
}

/** Restore TTY and exit. `code` defaults to 0 (clean quit); errors pass 1. */
function teardown(code = 0): void {
  present.stop();
  clearInterval(tickTimer);
  void worker.terminate();
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdout.write("\u001B[?25h\u001B[?7h\u001B[?1049l");
  process.stdout.write("\n");
  const s = fps.sample();
  console.error(`[quickdraw] last fps=${s.fps.toFixed(1)} frameMs=${s.frameMs.toFixed(1)} gen=${s.lastGen}`);
  process.exit(code);
}

function onFrame(_dt: number): void {
  fps.addDropped(mailbox.takeDropped());
  const snap = mailbox.peek();
  if (!snap) {
    fps.recordSkip();
    return;
  }

  // Still present when gen unchanged (clock panel updates only if tick advanced;
  // for steady fps measurement we always paint when we have a snapshot).
  const t0 = performance.now();
  const stats = fps.sample();
  fps.setGen(snap.gen);
  canvas = paint(snap.model, stats, canvas);
  const ansi = emitAnsi(prev, canvas, {
    sync2026: SYNC_2026,
    forceFull: prev === null || lastPaintedGen < 0,
  });
  if (ansi) process.stdout.write(ansi);
  prev = cloneBuffer(canvas);
  lastPaintedGen = snap.gen;
  fps.recordPresent(performance.now() - t0);
}

// --- boot ---

setupTerminal();
const { cols, rows } = termSize();

// Load the compiled worker beside this file. `tsc` emits `dist/bench/worker.js`;
// worker_threads + tsx is brittle for a `.js` specifier that should be `.ts`.
const workerPath = path.resolve(__dirname, "worker.js");
worker = new Worker(workerPath);

worker.on("message", (msg: WorkerToHost<Model>) => {
  if (msg.type === "snapshot") {
    mailbox.push(msg.snap as Snapshot<Model>);
  }
});

worker.on("error", (err) => {
  // Teardown ends in process.exit — log first, then exit non-zero (C9).
  console.error(err);
  teardown(1);
});

send({ type: "init", cols, rows });

const present = startPresentLoop({
  targetFps: TARGET_FPS,
  onFrame,
});

const tickTimer = setInterval(() => {
  send({ type: "tick", now: Date.now() });
}, TICK_MS);

process.stdout.on("resize", () => {
  const s = termSize();
  send({ type: "resize", cols: s.cols, rows: s.rows });
  prev = null; // keyframe after resize
});

process.stdin.on("data", (chunk: string | Buffer) => {
  const key = typeof chunk === "string" ? chunk : chunk.toString("utf8");
  if (key === "q" || key === "\u0003") {
    teardown();
    return;
  }
  send({ type: "key", key });
});

process.on("SIGINT", teardown);
process.on("SIGTERM", teardown);
