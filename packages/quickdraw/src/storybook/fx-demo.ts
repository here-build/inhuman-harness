/**
 * Fullscreen procedural bg demo — GLSL catalog only.
 *
 *   pnpm --filter @inhuman.tools/quickdraw fx
 *
 * Keys:
 *   1 gradient · 2 aurora · 3 doom · s split (grad|aurora)
 *   [ ] opacity down/up
 *   q quit
 */

import process from "node:process";

import { cloneBuffer, createBuffer, emitAnsi, fillBgFx, put, type Buffer as CellBuffer } from "../buffer/index.js";
import { createTtySession, detectCapabilities, startPresentLoop } from "../index.js";
import {
  DEFAULT_SHADERTOY_CATALOG,
  getBgFxOpacity,
  materializeBgFx,
  preferShaderWorker,
  registerShadertoyCatalog,
  setBgFxGround,
  setBgFxOpacity,
  shadertoyGlAvailable,
  type BgFxEnv,
  type BgFxId,
} from "../internals/bgfx/index.js";
import { quarantine } from "../lexicon/index.js";

const POOL: BgFxId[] = ["gradient", "aurora", "doom"];

type Mode = BgFxId | "split";

const tty = createTtySession({ sync2026: process.env.QD_SYNC !== "0" });
const targetFps = Number(process.env.QD_FPS ?? 30);
let mode: Mode = "aurora";
let prev: CellBuffer | null = null;
let structural: CellBuffer | null = null;
const t0 = performance.now();
let presenting = false;
let presentLoop: { stop: () => void } | null = null;
let tearingDown = false;
let glslReady = false;
let catalogMode: "worker" | "sync" | "—" = "—";
let mousePending = "";
const mouse = { x: 0, y: 0, z: 0, w: 0 };

setBgFxOpacity(0.28);

function size() {
  return {
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
  };
}

function paintMarkers(): CellBuffer {
  const { cols, rows } = size();
  const buf = createBuffer(cols, rows);

  if (mode === "split") {
    const half = Math.floor(cols / 2);
    fillBgFx(buf, { x: 0, y: 0, w: half, h: rows }, "gradient");
    fillBgFx(buf, { x: half, y: 0, w: cols - half, h: rows }, "aurora");
  } else {
    fillBgFx(buf, { x: 0, y: 0, w: cols, h: rows }, mode);
  }

  const op = getBgFxOpacity();
  const backend = catalogMode;
  const label = ` ${mode} · α=${op.toFixed(2)} · ${backend} · 1grad 2aurora 3doom · [] opacity · q `.slice(
    0,
    Math.max(0, cols - 2),
  );
  // fx-demo HUD (post-audit G9): demo-only — text over an arbitrary
  // procedural field has no role/prominence answer yet ("contrast over
  // arbitrary field" is a real, deferred gap), so the literal is
  // quarantined as artwork rather than left bare.
  put(buf, 1, 0, label, {
    bold: true,
    fgRgb: quarantine({ r: 200, g: 200, b: 210 }, "artwork"),
  });

  return buf;
}

async function present(): Promise<void> {
  if (presenting) return;
  presenting = true;
  try {
    if (!structural) structural = paintMarkers();
    const t = (performance.now() - t0) / 1000;
    const env: BgFxEnv = {
      t,
      resolution: { x: structural.width, y: structural.height },
      mouse: { ...mouse },
    };
    materializeBgFx(structural, env);
    const ansi = emitAnsi(prev, structural, {
      sync2026: process.env.QD_SYNC !== "0",
    });
    if (ansi) process.stdout.write(ansi);
    prev = cloneBuffer(structural);
  } finally {
    presenting = false;
  }
}

function rebuild(): void {
  structural = paintMarkers();
  prev = null;
}

async function setMode(next: Mode): Promise<{ ids: string[]; mode: "worker" | "sync" }> {
  const { cols, rows } = size();
  const worker = preferShaderWorker();
  const entry = next === "split" ? undefined : DEFAULT_SHADERTOY_CATALOG.find((e) => e.id === next);
  const r = await registerShadertoyCatalog({
    worker,
    width: cols,
    height: rows,
    entries: entry ? [entry] : undefined,
  });
  catalogMode = r.mode;
  mode = next;
  rebuild();
  return r;
}

function onKey(raw: Buffer): void {
  const s = raw.toString("utf8");
  // mouse peel minimal — optional
  if (s.includes("\u001B[<")) {
    mousePending += s;
    return;
  }
  const ch = s;
  if (ch === "q" || ch === "\u0003") {
    quit(0);
    return;
  }
  if (ch === "1") void setMode("gradient");
  if (ch === "2") void setMode("aurora");
  if (ch === "3") void setMode("doom");
  if (ch === "s") void setMode("split");
  if (ch === "[") {
    setBgFxOpacity(Math.max(0, getBgFxOpacity() - 0.05));
    rebuild();
  }
  if (ch === "]") {
    setBgFxOpacity(Math.min(1, getBgFxOpacity() + 0.05));
    rebuild();
  }
}

/**
 * Restore TTY: stop present loop, leave alt-screen, raw off.
 * Input modes off is inside exitBytes (before leave-alt). Idempotent.
 */
function restoreTty(): void {
  if (tearingDown) return;
  tearingDown = true;
  presentLoop?.stop();
  presentLoop = null;
  try {
    process.stdin.off("data", onKey);
  } catch {
    /* */
  }
  try {
    if (tty.entered) {
      process.stdout.write(tty.exitBytes());
      tty.markExited();
    }
  } catch {
    /* */
  }
  try {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
  } catch {
    /* */
  }
}

function quit(code = 0): void {
  restoreTty();
  process.exit(code);
}

async function main(): Promise<void> {
  if (!process.stdout.isTTY) {
    console.error("fx-demo: need a TTY");
    process.exit(1);
  }

  try {
    const { caps } = await detectCapabilities({
      stdin: process.stdin,
      stdout: process.stdout,
      timeoutMs: 120,
      batch: false,
    });
    if (caps.groundRgb) {
      setBgFxGround(caps.groundRgb);
      const gr = caps.groundRgb;
      console.error(`fx-demo: OSC11 ground rgb(${gr.r},${gr.g},${gr.b})`);
    }
  } catch {
    /* fallback ground */
  }

  if (!shadertoyGlAvailable()) {
    console.error("fx-demo: headless-gl unavailable — no GLSL bgFx");
    process.exit(1);
  }

  const envFx = process.env.QD_FX?.trim();
  const initial: Mode = envFx && (POOL as string[]).includes(envFx) ? (envFx as BgFxId) : "aurora";
  const r = await setMode(initial);
  glslReady = r.ids.length > 0;
  console.error(`fx-demo: [${r.ids.join(", ")}] mode=${r.mode} α=${getBgFxOpacity()}`);
  for (const id of r.ids) {
    const e = DEFAULT_SHADERTOY_CATALOG.find((row) => row.id === id);
    console.error(`  ${id} ← ${e?.file ?? "?"}`);
  }
  if (!glslReady) {
    console.error("fx-demo: empty catalog");
    process.exit(1);
  }

  process.stdout.write(tty.enterBytes());
  tty.markEntered();
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
  }
  process.stdin.on("data", onKey);
  process.on("SIGINT", () => quit(0));
  process.on("SIGTERM", () => quit(0));
  process.on("uncaughtException", (err) => {
    console.error("[fx-demo] uncaughtException:", err);
    quit(1);
  });
  process.on("unhandledRejection", (err) => {
    console.error("[fx-demo] unhandledRejection:", err);
    quit(1);
  });

  rebuild();
  // startPresentLoop catches sync frame throws; async present rejections
  // hit unhandledRejection → restoreTty. Fire-and-forget with local catch
  // keeps the loop alive for transient materialize failures.
  presentLoop = startPresentLoop({
    targetFps,
    onFrame: () => {
      void present().catch((error) => {
        console.error("[fx-demo] present:", error);
      });
    },
  });
  void present().catch((error) => {
    console.error("[fx-demo] present:", error);
  });
}

void main();
