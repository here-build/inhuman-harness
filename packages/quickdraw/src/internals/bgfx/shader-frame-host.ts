/**
 * Main-thread host for off-thread field frames (bg only, 1 sample / cell).
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";

import invariant from "tiny-invariant";

import { getBgFxNullField } from "./opacity.js";
import {
  HDR_FRAME_MS,
  HDR_GEN,
  HDR_H,
  HDR_STATUS,
  HDR_W,
  STATUS_OK,
  copyFrontFrame,
  envSabBytes,
  openEnvViews,
  openPixelViews,
  pixelSabBytes,
  writeEnv,
  type EnvViews,
  type PixelViews,
} from "./sab-layout.js";
import { resolveGlModulePath } from "./shadertoy-gl.js";
import type { BgFxEnv, BgFxFrame } from "./types.js";

export type ShaderFrameHostOpts = {
  source: string;
  width?: number;
  height?: number;
};

export type ShaderFrameHost = {
  pushEnv(w: number, h: number, env: BgFxEnv): void;
  readFrame(w: number, h: number): BgFxFrame;
  /** Recompile worker GLSL (await before using new shader). */
  switchSource(source: string): Promise<void>;
  lastFrameMs(): number;
  gen(): number;
  ready(): boolean;
  [Symbol.dispose](): void;
};

function allocPixelSab(w: number, h: number): SharedArrayBuffer {
  return new SharedArrayBuffer(pixelSabBytes(w, h));
}

function allocEnvSab(): SharedArrayBuffer {
  return new SharedArrayBuffer(envSabBytes());
}

/**
 * Worker entry is the package export (`dist/…`), not a sibling of this
 * file. `import.meta.url` + `../bgfx-worker.js` follows the executing
 * module — tsx/storybook load `src/` and miss the built worker.
 */
const BGFX_WORKER_ID = "@inhuman.tools/quickdraw/internals/bgfx-worker";

export function resolveBgfxWorkerPath(): string {
  try {
    return createRequire(import.meta.url).resolve(BGFX_WORKER_ID);
  } catch {
    invariant(false, `bgfx-worker missing (${BGFX_WORKER_ID}) — run @inhuman.tools/quickdraw build`);
  }
}

export async function createShaderFrameHost(opts: ShaderFrameHostOpts): Promise<ShaderFrameHost> {
  let w = Math.max(1, opts.width ?? 80);
  let h = Math.max(1, opts.height ?? 24);

  let pixelSab = allocPixelSab(w, h);
  const envSab = allocEnvSab();
  let pixel: PixelViews = openPixelViews(pixelSab);
  const envv: EnvViews = openEnvViews(envSab);

  Atomics.store(pixel.hdr, HDR_W, w);
  Atomics.store(pixel.hdr, HDR_H, h);
  Atomics.store(pixel.hdr, HDR_STATUS, 0);
  writeEnv(envv, { t: 0, w, h });

  const workerPath = resolveBgfxWorkerPath();
  invariant(existsSync(workerPath), `bgfx-worker missing at ${workerPath} — run @inhuman.tools/quickdraw build`);
  const glPath = resolveGlModulePath();
  invariant(glPath, "cannot resolve headless-gl module path for worker");
  const worker = new Worker(workerPath);

  const ready = new Promise<void>((resolve, reject) => {
    const onMsg = (msg: { type: string; message?: string }) => {
      if (msg.type === "ready") {
        worker.off("message", onMsg);
        resolve();
      } else if (msg.type === "error") {
        worker.off("message", onMsg);
        reject(new Error(msg.message ?? "shader worker error"));
      }
    };
    worker.on("message", onMsg);
    worker.on("error", (err) => {
      worker.off("message", onMsg);
      reject(err);
    });
  });

  worker.postMessage({
    type: "init",
    source: opts.source,
    pixelSab,
    envSab,
    glPath,
  });

  await ready;

  const scratch = new Map<string, Uint8Array>();

  function ensureSize(nw: number, nh: number): void {
    nw = Math.max(1, nw | 0);
    nh = Math.max(1, nh | 0);
    if (nw === w && nh === h) return;
    w = nw;
    h = nh;
    pixelSab = allocPixelSab(w, h);
    pixel = openPixelViews(pixelSab);
    Atomics.store(pixel.hdr, HDR_W, w);
    Atomics.store(pixel.hdr, HDR_H, h);
    worker.postMessage({ type: "rebind", pixelSab, envSab });
  }

  return {
    pushEnv(nw, nh, e) {
      ensureSize(nw, nh);
      writeEnv(envv, {
        t: e.t,
        w: nw,
        h: nh,
        mouse: e.mouse,
        polarity: e.polarity,
      });
    },
    switchSource(source: string) {
      return new Promise<void>((resolve, reject) => {
        const onMsg = (msg: { type: string; message?: string }) => {
          if (msg.type === "sourceReady") {
            worker.off("message", onMsg);
            resolve();
          } else if (msg.type === "error") {
            worker.off("message", onMsg);
            reject(new Error(msg.message ?? "setSource failed"));
          }
        };
        worker.on("message", onMsg);
        worker.on("error", (err) => {
          worker.off("message", onMsg);
          reject(err);
        });
        worker.postMessage({ type: "setSource", source });
      });
    },
    readFrame(nw, nh) {
      nw = Math.max(1, nw | 0);
      nh = Math.max(1, nh | 0);
      ensureSize(nw, nh);
      const key = `${nw}x${nh}`;
      let out = scratch.get(key);
      const need = nw * nh * 4;
      if (!out || out.length !== need) {
        out = new Uint8Array(need);
        scratch.set(key, out);
      }
      // M1: gate on STATUS — between SAB rebind (ensureSize) and the worker's
      // first paint, copyFrontFrame can return true over uninitialized zero
      // bytes. Treat !ready() the same as a failed copy: fill the sentinel so
      // we never hand back a zero/black frame masquerading as valid shader output.
      const statusOk = Atomics.load(pixel.hdr, HDR_STATUS) === STATUS_OK;
      const ok = statusOk && copyFrontFrame(pixel, out, nw, nh);
      if (!ok) {
        const { r, g, b } = getBgFxNullField();
        for (let i = 0; i < need; i += 4) {
          out[i] = r;
          out[i + 1] = g;
          out[i + 2] = b;
          out[i + 3] = 255;
        }
      }
      return { width: nw, height: nh, rgba: out };
    },
    lastFrameMs() {
      return Atomics.load(pixel.hdr, HDR_FRAME_MS);
    },
    gen() {
      return Atomics.load(pixel.hdr, HDR_GEN);
    },
    ready() {
      return Atomics.load(pixel.hdr, HDR_STATUS) === STATUS_OK;
    },
    [Symbol.dispose]() {
      try {
        worker.postMessage({ type: "stop" });
      } catch {
        /* ignore */
      }
      void worker.terminate();
    },
  };
}
