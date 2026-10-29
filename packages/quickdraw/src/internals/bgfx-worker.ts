/**
 * Worker: field GLSL → cell-resolution RGBA → SharedArrayBuffer.
 * One sample per terminal cell (background only).
 */

import { parentPort } from "node:worker_threads";

import invariant from "tiny-invariant";

import {
  ENV_H,
  ENV_MW,
  ENV_MX,
  ENV_MY,
  ENV_MZ,
  ENV_POLARITY,
  ENV_T,
  ENV_W,
  HDR_FRONT,
  HDR_H,
  HDR_STATUS,
  HDR_W,
  STATUS_BOOT,
  STATUS_ERR,
  STATUS_OK,
  beginSlotWrite,
  endSlotWrite,
  openEnvViews,
  openPixelViews,
  slotOffset,
  type EnvViews,
  type PixelViews,
} from "./bgfx/sab-layout.js";
import { createShadertoyProgram, setGlModulePath } from "./bgfx/shadertoy-gl.js";

type InitMsg = {
  type: "init";
  source: string;
  pixelSab: SharedArrayBuffer;
  envSab: SharedArrayBuffer;
  glPath?: string;
};
type RebindMsg = {
  type: "rebind";
  pixelSab: SharedArrayBuffer;
  envSab: SharedArrayBuffer;
};
type SetSourceMsg = { type: "setSource"; source: string };
type StopMsg = { type: "stop" };
type InMsg = InitMsg | RebindMsg | SetSourceMsg | StopMsg;

invariant(parentPort, "shader-frame-worker must run as a worker_thread");
const port = parentPort;

let running = false;
let pixel: PixelViews | null = null;
let env: EnvViews | null = null;
let program: ReturnType<typeof createShadertoyProgram> | null = null;
let back: 0 | 1 = 1;
let loopTimer: ReturnType<typeof setTimeout> | null = null;

function fail(msg: string): void {
  if (pixel) Atomics.store(pixel.hdr, HDR_STATUS, STATUS_ERR);
  port.postMessage({ type: "error", message: msg });
}

function tick(): void {
  if (!running || !pixel || !env || !program) return;

  const w = Atomics.load(env.i32, ENV_W);
  const h = Atomics.load(env.i32, ENV_H);
  if (w <= 0 || h <= 0) {
    schedule();
    return;
  }

  const sabW = Atomics.load(pixel.hdr, HDR_W);
  const sabH = Atomics.load(pixel.hdr, HDR_H);
  if (sabW !== w || sabH !== h) {
    schedule();
    return;
  }

  const t = env.f32[ENV_T]!;
  const mouse = {
    x: env.f32[ENV_MX]!,
    y: env.f32[ENV_MY]!,
    z: env.f32[ENV_MZ]!,
    w: env.f32[ENV_MW]!,
  };
  const polarity = env.f32[ENV_POLARITY]! < 0 ? "light" : "dark";

  try {
    const t0 = performance.now();
    const frame = program.renderFrame(w, h, {
      t,
      resolution: { x: w, y: h },
      mouse,
      polarity,
    });
    const ms = performance.now() - t0;

    const slot = back;
    beginSlotWrite(pixel.hdr, slot);
    const off = slotOffset(w, h, slot);
    pixel.bytes.set(frame.rgba.subarray(0, w * h * 4), off);
    endSlotWrite(pixel.hdr, slot, ms);
    back = slot === 0 ? 1 : 0;
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    running = false;
    return;
  }

  schedule();
}

function schedule(): void {
  if (!running) return;
  loopTimer = setTimeout(tick, 0);
}

function bindSabs(pixelSab: SharedArrayBuffer, envSab: SharedArrayBuffer): void {
  pixel = openPixelViews(pixelSab);
  env = openEnvViews(envSab);
  Atomics.store(pixel.hdr, HDR_STATUS, STATUS_BOOT);
  Atomics.store(pixel.hdr, HDR_FRONT, 0);
  back = 1;
}

port.on("message", (msg: InMsg) => {
  if (msg.type === "stop") {
    running = false;
    if (loopTimer) clearTimeout(loopTimer);
    program?.[Symbol.dispose]();
    program = null;
    port.postMessage({ type: "stopped" });
    return;
  }

  if (msg.type === "rebind") {
    bindSabs(msg.pixelSab, msg.envSab);
    const w = Atomics.load(env!.i32, ENV_W);
    const h = Atomics.load(env!.i32, ENV_H);
    if (w > 0 && h > 0) {
      Atomics.store(pixel!.hdr, HDR_W, w);
      Atomics.store(pixel!.hdr, HDR_H, h);
    }
    Atomics.store(pixel!.hdr, HDR_STATUS, STATUS_OK);
    port.postMessage({ type: "rebound" });
    return;
  }

  if (msg.type === "setSource") {
    try {
      invariant(program, "setSource before init");
      program.setSource(msg.source);
      port.postMessage({ type: "sourceReady" });
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    return;
  }

  if (msg.type === "init") {
    try {
      if (msg.glPath) setGlModulePath(msg.glPath);
      bindSabs(msg.pixelSab, msg.envSab);
      program?.[Symbol.dispose]();
      program = createShadertoyProgram(msg.source);
      program.ensureCompiled();
      running = true;
      Atomics.store(pixel!.hdr, HDR_STATUS, STATUS_OK);
      port.postMessage({ type: "ready" });
      schedule();
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }
});
