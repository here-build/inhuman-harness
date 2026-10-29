/**
 * GLSL (Shadertoy-shaped) bgFx catalog.
 * Shared worker host by default; re-register to switch source.
 * Product backgrounds are **shaders only** — no CPU stock dual-world.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import invariant from "tiny-invariant";

import { getBgFxNullField } from "./opacity.js";
import { registerBgFxShader, unregisterBgFxShader } from "./registry.js";
import { createShaderFrameHost, type ShaderFrameHost } from "./shader-frame-host.js";
import { createShadertoyProgram, shadertoyGlAvailable, type ShadertoyProgram } from "./shadertoy-gl.js";

export type ShadertoyEntry = {
  id: string;
  file: string;
};

/** Product pool — all GLSL under quickdraw root. */
export const DEFAULT_SHADERTOY_CATALOG: readonly ShadertoyEntry[] = [
  { id: "gradient", file: "gradient.vert" },
  { id: "aurora", file: "aurora.vert" },
  { id: "doom", file: "doom.vert" },
] as const;

/**
 * Resolve the quickdraw workspace root (where `*.vert` assets live).
 *
 * Walks up from this module looking for known shader files or the workspace
 * package.json — does not hard-code nesting depth (B6: dist/ vs src/ hops).
 */
export function quickdrawRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, "gradient.vert")) || existsSync(join(dir, "aurora.vert"))) {
      return dir;
    }
    const pj = join(dir, "package.json");
    if (existsSync(pj)) {
      try {
        const name = (JSON.parse(readFileSync(pj, "utf8")) as { name?: string }).name;
        if (name === "@inhuman.tools/quickdraw") return dir;
      } catch {
        /* keep walking */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Last resort: historical packages/bgfx/{src,dist} → quickdraw/
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
}

type EntryState = {
  id: string;
  file: string;
  source: string;
};

let entries = new Map<string, EntryState>();
let activeId: string | null = null;
let workerHost: ShaderFrameHost | null = null;
const syncHosts = new Map<string, ShadertoyProgram>();
let mode: "worker" | "sync" | null = null;

function loadFile(root: string, file: string): string {
  const p = resolve(root, file);
  invariant(existsSync(p), `shader not found: ${p}`);
  return readFileSync(p, "utf8");
}

function disposeAll(): void {
  workerHost?.[Symbol.dispose]();
  workerHost = null;
  for (const h of syncHosts.values()) h[Symbol.dispose]();
  syncHosts.clear();
  for (const id of entries.keys()) unregisterBgFxShader(id);
  entries = new Map();
  activeId = null;
  mode = null;
}

/** BGFX_NULL_FIELD fill — inactive/unregistered id, not literal black. */
let nullCached: { w: number; h: number; r: number; g: number; b: number; rgba: Uint8Array } | null = null;

function nullFrame(w: number, h: number) {
  const ww = Math.max(1, w);
  const hh = Math.max(1, h);
  const { r, g, b } = getBgFxNullField();
  if (
    nullCached &&
    nullCached.w === ww &&
    nullCached.h === hh &&
    nullCached.r === r &&
    nullCached.g === g &&
    nullCached.b === b
  ) {
    return { width: ww, height: hh, rgba: nullCached.rgba };
  }
  const rgba = new Uint8Array(ww * hh * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = r;
    rgba[i + 1] = g;
    rgba[i + 2] = b;
    rgba[i + 3] = 255;
  }
  nullCached = { w: ww, h: hh, r, g, b, rgba };
  return { width: ww, height: hh, rgba };
}

function registerOne(e: EntryState): void {
  registerBgFxShader({
    id: e.id,
    renderFrame: (w, h, env) => {
      if (mode === "worker" && workerHost) {
        if (activeId !== e.id) return nullFrame(w, h);
        workerHost.pushEnv(w, h, env);
        return workerHost.readFrame(w, h);
      }
      const host = syncHosts.get(e.id);
      if (!host) return nullFrame(w, h);
      return host.renderFrame(w, h, env);
    },
  });
}

/** Prefer worker unless `worker: false` or `QD_BGFX_SYNC=1`. */
export function preferShaderWorker(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.QD_BGFX_SYNC !== "1";
}

/**
 * Register GLSL files as bgFx programs (renderFrame only).
 * Shared worker by default.
 */
export async function registerShadertoyCatalog(opts?: {
  root?: string;
  entries?: ShadertoyEntry[];
  worker?: boolean;
  width?: number;
  height?: number;
}): Promise<{ ids: string[]; mode: "worker" | "sync" }> {
  if (!shadertoyGlAvailable()) {
    return { ids: [], mode: "sync" };
  }

  const root = opts?.root ?? quickdrawRoot();
  const list = opts?.entries ?? [...DEFAULT_SHADERTOY_CATALOG];
  const wantWorker = opts?.worker !== false && preferShaderWorker();

  disposeAll();

  for (const e of list) {
    try {
      const source = loadFile(root, e.file);
      entries.set(e.id, {
        id: e.id,
        file: e.file,
        source,
      });
    } catch (error) {
      console.error(`[bgfx] skip ${e.id}:`, error instanceof Error ? error.message : error);
    }
  }

  if (entries.size === 0) return { ids: [], mode: "sync" };
  const first = [...entries.values()][0]!;

  if (wantWorker) {
    try {
      workerHost = await createShaderFrameHost({
        source: first.source,
        width: opts?.width ?? 80,
        height: opts?.height ?? 24,
      });
      mode = "worker";
      activeId = first.id;
      for (const e of entries.values()) registerOne(e);
      return { ids: [...entries.keys()], mode: "worker" };
    } catch (error) {
      console.error("[bgfx] catalog worker failed, sync per-shader:", error instanceof Error ? error.message : error);
      workerHost = null;
    }
  }

  mode = "sync";
  try {
    for (const e of entries.values()) {
      const host = createShadertoyProgram(e.source);
      host.ensureCompiled();
      syncHosts.set(e.id, host);
      registerOne(e);
    }
  } catch (error) {
    console.error("[bgfx] catalog sync compile failed:", error instanceof Error ? error.message : error);
    disposeAll();
    return { ids: [], mode: "sync" };
  }
  activeId = first.id;
  return { ids: [...entries.keys()], mode: "sync" };
}

export function unregisterShadertoyCatalog(): void {
  disposeAll();
}

/**
 * Worker hosts one GLSL source. Point it at `id` (no-op if already there).
 * Resolves true when the source actually changed — caller may requestPaint.
 */
export async function activateShadertoy(id: string): Promise<boolean> {
  const entry = entries.get(id);
  if (!entry) return false;
  if (activeId === id) return false;
  activeId = id;
  if (mode === "worker" && workerHost) {
    await workerHost.switchSource(entry.source);
  }
  return true;
}
