/**
 * Shadertoy GLSL host via headless-gl (optional native dep `gl`).
 *
 * Renders full frames (not per-cell samples) — correct for heavy raytracers
 * like Doom E1M1. Call `renderFrame(w,h,env)` once per present, scatter RGBA.
 */

import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import invariant from "tiny-invariant";

import type { BgFxEnv } from "./types.js";

export type ShadertoyFrame = {
  width: number;
  height: number;
  /** RGBA row-major, top-left origin (y flipped from GL). */
  rgba: Uint8Array;
};

type GL = {
  VERTEX_SHADER: number;
  FRAGMENT_SHADER: number;
  COMPILE_STATUS: number;
  LINK_STATUS: number;
  ARRAY_BUFFER: number;
  STATIC_DRAW: number;
  FLOAT: number;
  TRIANGLE_STRIP: number;
  RGBA: number;
  UNSIGNED_BYTE: number;
  COLOR_BUFFER_BIT: number;
  TEXTURE_2D: number;
  TEXTURE0: number;
  TEXTURE_MIN_FILTER: number;
  TEXTURE_MAG_FILTER: number;
  TEXTURE_WRAP_S: number;
  TEXTURE_WRAP_T: number;
  CLAMP_TO_EDGE: number;
  NEAREST: number;
  createShader(t: number): unknown;
  shaderSource(s: unknown, src: string): void;
  compileShader(s: unknown): void;
  getShaderParameter(s: unknown, p: number): boolean;
  getShaderInfoLog(s: unknown): string;
  createProgram(): unknown;
  attachShader(p: unknown, s: unknown): void;
  linkProgram(p: unknown): void;
  getProgramParameter(p: unknown, p2: number): boolean;
  getProgramInfoLog(p: unknown): string;
  useProgram(p: unknown): void;
  createBuffer(): unknown;
  bindBuffer(t: number, b: unknown): void;
  bufferData(t: number, data: ArrayBufferView, usage: number): void;
  getAttribLocation(p: unknown, name: string): number;
  enableVertexAttribArray(i: number): void;
  vertexAttribPointer(i: number, size: number, type: number, norm: boolean, stride: number, offset: number): void;
  getUniformLocation(p: unknown, name: string): unknown;
  uniform1f(loc: unknown, v: number): void;
  uniform1i(loc: unknown, v: number): void;
  uniform3f(loc: unknown, x: number, y: number, z: number): void;
  uniform4f(loc: unknown, x: number, y: number, z: number, w: number): void;
  createTexture(): unknown;
  bindTexture(t: number, tex: unknown): void;
  activeTexture(u: number): void;
  texParameteri(t: number, p: number, v: number): void;
  texImage2D(
    t: number,
    level: number,
    ifmt: number,
    w: number,
    h: number,
    border: number,
    fmt: number,
    type: number,
    data: ArrayBufferView,
  ): void;
  viewport(x: number, y: number, w: number, h: number): void;
  clearColor(r: number, g: number, b: number, a: number): void;
  clear(m: number): void;
  drawArrays(mode: number, first: number, count: number): void;
  readPixels(x: number, y: number, w: number, h: number, f: number, t: number, pixels: ArrayBufferView): void;
  getExtension(name: string): { destroy(): void } | null;
};

type CreateGL = (w: number, h: number, opts?: { preserveDrawingBuffer?: boolean }) => GL | null;

function asCreateGL(mod: unknown): CreateGL | null {
  if (typeof mod === "function") return mod as CreateGL;
  if (mod && typeof mod === "object" && "default" in mod) {
    const d = (mod as { default: unknown }).default;
    if (typeof d === "function") return d as CreateGL;
  }
  return null;
}

/** Optional absolute path injected via workerData (main resolves `gl` reliably). */
let glModulePathOverride: string | null = null;
let lastGlLoadError: string | null = null;

export function setGlModulePath(absPath: string | null): void {
  glModulePathOverride = absPath;
  lastGlLoadError = null;
}

/**
 * Resolve path to `gl` **without loading** the native addon.
 * Loading `webgl.node` on main + worker causes "Module did not self-register"
 * under vitest's thread pool — worker path must be the sole loader when used.
 */
export function resolveGlModulePath(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const packageRoot = resolve(here, "..");
  const attempts: Array<{ requireFrom: string; id: string }> = [
    { requireFrom: import.meta.url, id: "gl" },
    { requireFrom: resolve(packageRoot, "package.json"), id: "gl" },
  ];
  for (const { requireFrom, id } of attempts) {
    try {
      const require = createRequire(requireFrom);
      return require.resolve(id);
    } catch {
      /* next */
    }
  }
  return null;
}

function loadCreateGL(): CreateGL | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const packageRoot = resolve(here, "..");

  // Prefer absolute path from main (vitest nested-worker resolve is flaky).
  if (glModulePathOverride) {
    try {
      const require = createRequire(glModulePathOverride);
      const fn = asCreateGL(require(glModulePathOverride));
      if (fn) return fn;
    } catch (error) {
      lastGlLoadError = error instanceof Error ? error.message : String(error);
    }
  }

  const ids = ["gl", resolve(packageRoot, "node_modules/gl/index.js")];
  const requireFroms = [import.meta.url, resolve(packageRoot, "package.json")];
  for (const requireFrom of requireFroms) {
    for (const id of ids) {
      try {
        const require = createRequire(requireFrom);
        const fn = asCreateGL(require(id));
        if (fn) return fn;
      } catch {
        /* next */
      }
    }
  }
  return null;
}

export function shadertoyGlAvailable(): boolean {
  // Resolve-only — do not load native addon (worker exclusivity).
  return resolveGlModulePath() !== null;
}

const VS = `
attribute vec2 a_pos;
void main() {
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

/** WebGL1-friendly preprocessing for Shadertoy sources. */
export function preprocessShadertoySource(source: string): string {
  let body = source.replace(/^\s*#version[^\n]*\n/, "");
  // GLSL ES 1.00 / WebGL1 aliases
  body = body.replaceAll(/\bmat2x2\b/g, "mat2");
  body = body.replaceAll(/\btexture\s*\(/g, "texture2D(");
  // Terminal budget: drop AA multi-sample if present
  body = body.replaceAll(/#define\s+AA\s+\d+/g, "#define AA 1");
  // uvec* hash (WebGL2) → float hash (WebGL1). Matches nimitz-style nmzHash33.
  body = body.replace(
    /vec3\s+nmzHash33\s*\(\s*vec3\s+q\s*\)\s*\{[\s\S]*?return\s+vec3\s*\([^;]+;\s*\}/,
    `vec3 nmzHash33(vec3 q){
    vec3 p = floor(q);
    p = fract(p * vec3(0.1031, 0.1030, 0.0973));
    p += dot(p, p.yxz + 33.33);
    return fract((p.xxy + p.yxx) * p.zyx);
}`,
  );
  return body;
}

/** 1×1 white — iChannel stubs. One allocation for the process, not per frame. */
const WHITE_1X1 = new Uint8Array([255, 255, 255, 255]);

function wrapShadertoy(source: string): string {
  const body = preprocessShadertoySource(source);
  return `
precision highp float;

uniform vec3 iResolution;
uniform float iTime;
uniform float iTimeDelta;
uniform float iFrame;
uniform float iFrameRate;
uniform vec4 iMouse;
uniform vec4 iDate;
uniform float iSampleRate;
uniform float iPolarity;
uniform sampler2D iChannel0;
uniform sampler2D iChannel1;
uniform sampler2D iChannel2;
uniform sampler2D iChannel3;

${body}

void main() {
  vec4 col;
  mainImage(col, gl_FragCoord.xy);
  gl_FragColor = col;
}
`;
}

export type ShadertoyProgram = {
  /** Compile GLSL (throws on compile/link error). */
  ensureCompiled(): void;
  /** Hot-swap fragment source (recompile). */
  setSource(source: string): void;
  /** Render one frame; returns top-left origin RGBA. */
  renderFrame(w: number, h: number, env: BgFxEnv): ShadertoyFrame;
  [Symbol.dispose](): void;
};

/**
 * Create a reusable Shadertoy host for one GLSL source (mainImage entry).
 * Context is recreated when size changes.
 */
export function createShadertoyProgram(glslSource: string): ShadertoyProgram {
  const createGL = loadCreateGL();
  invariant(
    createGL,
    `headless-gl (\`gl\` package) not available — cannot run Shadertoy GLSL` +
      ` (glPathOverride=${glModulePathOverride ?? "null"}; err=${lastGlLoadError ?? "n/a"})`,
  );

  let gl: GL | null = null;
  let prog: unknown = null;
  let channelTex: unknown = null;
  let ctxW = 0;
  let ctxH = 0;
  let frameCount = 0;
  let fragSrc = wrapShadertoy(glslSource);
  const makeGL = createGL;
  /** Readback + Y-flip. Reallocated only when `ensureSize` changes w×h. */
  let raw = new Uint8Array(0);
  let rgba = new Uint8Array(0);

  function compileShader(g: GL, type: number, src: string): unknown {
    const s = g.createShader(type);
    g.shaderSource(s, src);
    g.compileShader(s);
    invariant(g.getShaderParameter(s, g.COMPILE_STATUS), () => `GLSL compile: ${g.getShaderInfoLog(s)}`);
    return s;
  }

  function bindDummyChannels(g: GL, p: unknown): void {
    // 1×1 white — stubs iChannel0..3 for shaders that sample them
    if (!channelTex) {
      channelTex = g.createTexture();
      g.bindTexture(g.TEXTURE_2D, channelTex);
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.NEAREST);
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.NEAREST);
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE);
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
      g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, 1, 1, 0, g.RGBA, g.UNSIGNED_BYTE, WHITE_1X1);
    }
    for (let i = 0; i < 4; i++) {
      g.activeTexture(g.TEXTURE0 + i);
      g.bindTexture(g.TEXTURE_2D, channelTex);
      const loc = g.getUniformLocation(p, `iChannel${i}`);
      if (loc != null) g.uniform1i(loc, i);
    }
    g.activeTexture(g.TEXTURE0);
  }

  function linkProgram(g: GL): void {
    const p = g.createProgram();
    g.attachShader(p, compileShader(g, g.VERTEX_SHADER, VS));
    g.attachShader(p, compileShader(g, g.FRAGMENT_SHADER, fragSrc));
    g.linkProgram(p);
    invariant(g.getProgramParameter(p, g.LINK_STATUS), () => `GLSL link: ${g.getProgramInfoLog(p)}`);
    prog = p;
    g.useProgram(p);
    const vbo = g.createBuffer();
    g.bindBuffer(g.ARRAY_BUFFER, vbo);
    g.bufferData(g.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), g.STATIC_DRAW);
    const loc = g.getAttribLocation(p, "a_pos");
    g.enableVertexAttribArray(loc);
    g.vertexAttribPointer(loc, 2, g.FLOAT, false, 0, 0);
    bindDummyChannels(g, p);
  }

  function ensureSize(w: number, h: number): void {
    if (gl && ctxW === w && ctxH === h && prog) return;
    if (gl) {
      gl.getExtension("STACKGL_destroy_context")?.destroy();
      gl = null;
      prog = null;
      channelTex = null;
    }
    const g = makeGL(w, h, { preserveDrawingBuffer: true });
    invariant(g, "createGL failed");
    gl = g;
    ctxW = w;
    ctxH = h;
    const need = w * h * 4;
    if (raw.length !== need) {
      raw = new Uint8Array(need);
      rgba = new Uint8Array(need);
    }
    linkProgram(g);
  }

  return {
    ensureCompiled() {
      ensureSize(4, 4);
    },
    /** Hot-swap GLSL (recompile); keeps context size. */
    setSource(source: string) {
      fragSrc = wrapShadertoy(source);
      if (gl) {
        linkProgram(gl);
      } else {
        ensureSize(4, 4);
      }
      frameCount = 0;
    },
    renderFrame(w: number, h: number, env: BgFxEnv): ShadertoyFrame {
      const width = Math.max(1, w | 0);
      const height = Math.max(1, h | 0);
      ensureSize(width, height);
      const g = gl!;
      g.useProgram(prog);
      bindDummyChannels(g, prog);
      g.viewport(0, 0, width, height);
      g.uniform3f(g.getUniformLocation(prog, "iResolution"), width, height, 1);
      g.uniform1f(g.getUniformLocation(prog, "iTime"), env.t);
      g.uniform1f(g.getUniformLocation(prog, "iPolarity"), env.polarity === "light" ? -1 : 1);
      g.uniform1f(g.getUniformLocation(prog, "iTimeDelta"), 1 / 30);
      g.uniform1f(g.getUniformLocation(prog, "iFrame"), frameCount++);
      g.uniform1f(g.getUniformLocation(prog, "iFrameRate"), 30);
      const m = env.mouse ?? { x: 0, y: 0, z: 0, w: 0 };
      // Shadertoy iMouse in pixels; accept 0..1 normalized or pixel-ish
      const mx = m.x <= 1 && m.y <= 1 ? m.x * width : m.x;
      const my = m.x <= 1 && m.y <= 1 ? m.y * height : m.y;
      const mz = m.z <= 1 && m.z > 0 ? m.z * width : m.z;
      const mw = m.w <= 1 && m.w > 0 ? m.w * height : m.w;
      g.uniform4f(g.getUniformLocation(prog, "iMouse"), mx, my, mz, mw);
      const now = new Date();
      g.uniform4f(
        g.getUniformLocation(prog, "iDate"),
        now.getFullYear(),
        now.getMonth(),
        now.getDate(),
        now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds() + now.getMilliseconds() / 1000,
      );

      g.clearColor(0, 0, 0, 1);
      g.clear(g.COLOR_BUFFER_BIT);
      g.drawArrays(g.TRIANGLE_STRIP, 0, 4);

      g.readPixels(0, 0, width, height, g.RGBA, g.UNSIGNED_BYTE, raw);

      // Flip Y → top-left origin for cell mapping. `rgba` is reused;
      // valid until the next renderFrame / resize.
      const row = width * 4;
      for (let y = 0; y < height; y++) {
        const src = (height - 1 - y) * row;
        rgba.set(raw.subarray(src, src + row), y * row);
      }
      return { width, height, rgba };
    },
    [Symbol.dispose]() {
      if (gl) {
        gl.getExtension("STACKGL_destroy_context")?.destroy();
        gl = null;
      }
      prog = null;
    },
  };
}
