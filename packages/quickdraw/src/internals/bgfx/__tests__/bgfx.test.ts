import { existsSync } from "node:fs";

import { expect, test } from "vitest";

import { createBuffer, fillBgFx, mergeStyle, put } from "../../../buffer/index.js";
import {
  blendBgFx,
  materializeBgFx,
  registerBgFxShader,
  activateShadertoy,
  registerShadertoyCatalog,
  setBgFxGround,
  setBgFxOpacity,
  shadertoyGlAvailable,
  unregisterBgFxShader,
  resolveBgfxWorkerPath,
  unregisterShadertoyCatalog,
} from "../index.js";

const DEFAULT_OPACITY = 0.28;
const DEFAULT_GROUND = { r: 10, g: 10, b: 14 };

test("bgfx-worker resolves via the package export, not src/", () => {
  const path = resolveBgfxWorkerPath().replaceAll("\\", "/");
  expect({
    dist: path.endsWith("/dist/internals/bgfx-worker.js"),
    exists: existsSync(path),
  }).toEqual({ dist: true, exists: true });
});

test("bgFx materialize + catalog", async () => {
  try {
    registerBgFxShader({
      id: "solid-red",
      renderFrame: (w, h) => {
        const rgba = new Uint8Array(w * h * 4);
        for (let i = 0; i < rgba.length; i += 4) {
          rgba[i] = 200;
          rgba[i + 1] = 20;
          rgba[i + 2] = 20;
          rgba[i + 3] = 255;
        }
        return { width: w, height: h, rgba };
      },
    });
    setBgFxOpacity(1);
    const sampleBuf = createBuffer(3, 2);
    fillBgFx(sampleBuf, { x: 0, y: 0, w: 3, h: 2 }, "solid-red");
    materializeBgFx(sampleBuf, 0);
    expect({
      bgRgb: sampleBuf.cells[0]!.style.bgRgb,
      bgFx: sampleBuf.cells[0]!.style.bgFx,
    }).toEqual({
      bgRgb: { r: 200, g: 20, b: 20 },
      bgFx: "solid-red",
    });

    registerBgFxShader({
      id: "solid-red",
      renderFrame: (w, h) => {
        const rgba = new Uint8Array(w * h * 4);
        for (let i = 0; i < rgba.length; i += 4) {
          rgba[i] = 10;
          rgba[i + 1] = 20;
          rgba[i + 2] = 30;
          rgba[i + 3] = 255;
        }
        return { width: w, height: h, rgba };
      },
    });
    const inheritBuf = createBuffer(4, 1);
    fillBgFx(inheritBuf, { x: 0, y: 0, w: 4, h: 1 }, "solid-red");
    put(inheritBuf, 0, 0, "hi", { fg: 15 });
    expect(inheritBuf.cells[0]!.style.bgFx).toEqual("solid-red");

    expect(mergeStyle({ bgFx: "solid-red" }, { bg: 235 })).toEqual({ bg: 235 });

    setBgFxGround({ r: 40, g: 40, b: 80 });
    setBgFxOpacity(0.5);
    const blended = blendBgFx({ r: 200, g: 100, b: 50 });
    expect({ towardGround: blended.r > 40, towardField: blended.r < 200 }).toEqual({
      towardGround: true,
      towardField: true,
    });

    const sync = await registerShadertoyCatalog({
      worker: false,
      width: 32,
      height: 16,
    });
    if (sync.ids.length > 0) {
      expect(sync.mode).toEqual("sync");
      expect(sync.ids).toEqual(expect.arrayContaining(["gradient", "aurora", "doom"]));
      setBgFxOpacity(1);
      setBgFxGround({ r: 0, g: 0, b: 0 });
      const buf = createBuffer(32, 16);
      fillBgFx(buf, { x: 0, y: 0, w: 32, h: 16 }, sync.ids[0]!);
      materializeBgFx(buf, 2);
      let lit = 0;
      for (const c of buf.cells) {
        const rgb = c.style.bgRgb;
        if (rgb && rgb.r + rgb.g + rgb.b > 20) lit += 1;
      }
      expect(lit > 10).toEqual(true);
    } else {
      expect(sync).toEqual({ ids: [], mode: "sync" });
      expect(typeof shadertoyGlAvailable()).toEqual("boolean");
    }

    const worker = await registerShadertoyCatalog({
      worker: true,
      width: 24,
      height: 12,
    });
    if (worker.ids.length > 0) {
      expect(await activateShadertoy("aurora")).toBe(true);
      expect(await activateShadertoy("aurora")).toBe(false);
      expect(worker.mode === "worker" || worker.mode === "sync").toEqual(true);
      setBgFxOpacity(1);
      const buf = createBuffer(24, 12);
      fillBgFx(buf, { x: 0, y: 0, w: 24, h: 12 }, worker.ids[0]!);
      materializeBgFx(buf, 1);
      expect(buf.cells.some((c) => c.style.bgRgb)).toEqual(true);
    } else {
      expect(worker).toEqual({ ids: [], mode: "sync" });
    }
  } finally {
    unregisterBgFxShader("solid-red");
    try {
      unregisterShadertoyCatalog();
    } catch {
      /* catalog may not have registered */
    }
    setBgFxOpacity(DEFAULT_OPACITY);
    setBgFxGround(DEFAULT_GROUND);
  }
});
