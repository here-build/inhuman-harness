import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PNG } from "pngjs";
import { afterEach, describe, expect, it } from "vitest";

import {
  bindVisualStore,
  decodeVisualBytes,
  fitVisual,
  modelSeesImages,
  readVisual,
  VISUAL_TOO_LARGE,
  VISUAL_TYPE,
  VISUAL_UNREADABLE,
  writeVisual,
} from "../visual-store.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "visual-store-"));
  roots.push(root);
  bindVisualStore(root);
  return root;
}

function solidPng(width: number, height: number): Buffer {
  return PNG.sync.write(new PNG({ width, height }));
}

function jpeg(width: number, height: number): Uint8Array {
  return Uint8Array.from([
    0xff,
    0xd8,
    0xff,
    0xc0,
    0x00,
    0x0b,
    0x08,
    height >> 8,
    height & 0xff,
    width >> 8,
    width & 0xff,
    0x01,
    0x01,
    0x11,
    0x00,
    0xff,
    0xd9,
  ]);
}

describe("visual store", () => {
  it("downscales a wide png and names the original size", () => {
    const fit = fitVisual({ mime: "image/png", bytes: solidPng(3000, 10), sourcePath: " shot.png " });
    expect(fit.ok).toBe(true);
    if (!fit.ok) return;
    expect(fit.width).toBe(2048);
    expect(fit.height).toBe(7);
    expect(fit.resizedFrom).toEqual({ width: 3000, height: 10 });
    expect(fit.mime).toBe("image/png");
    expect(fit.sourcePath).toBe("shot.png");
    expect(PNG.sync.read(Buffer.from(fit.bytes)).width).toBe(2048);
  });

  it("keeps a small png and refuses an oversized jpeg", () => {
    const small = fitVisual({ mime: "image/png", bytes: solidPng(8, 8) });
    expect(small.ok).toBe(true);
    if (!small.ok) return;
    expect(small.resizedFrom).toBeNull();
    expect(fitVisual({ mime: "image/jpeg", bytes: jpeg(3000, 8) })).toEqual({
      ok: false,
      reason: VISUAL_TOO_LARGE,
    });
    expect(fitVisual({ mime: "image/tiff", bytes: solidPng(8, 8) })).toEqual({
      ok: false,
      reason: VISUAL_TYPE,
    });
    expect(fitVisual({ mime: "image/jpeg", bytes: Uint8Array.from([1, 2, 3]) })).toEqual({
      ok: false,
      reason: VISUAL_UNREADABLE,
    });
    const gif = fitVisual({
      mime: "image/gif",
      bytes: Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 8, 0, 8, 0]),
    });
    expect(gif.ok && gif.width).toBe(8);
  });

  it("treats an unknown model as text-only", () => {
    expect(modelSeesImages("gpt-4o-mini")).toBe(true);
    expect(modelSeesImages("GPT-4o")).toBe(true);
    expect(modelSeesImages("claude-3")).toBe(true);
    expect(modelSeesImages("grok-4")).toBe(true);
    expect(modelSeesImages("gpt-4-turbo")).toBe(false);
    expect(modelSeesImages("gpt-4")).toBe(false);
    expect(modelSeesImages("")).toBe(false);
    expect(modelSeesImages("unknown")).toBe(false);
  });

  it("stores bytes beside the session and rejects a path id", () => {
    const root = tempRoot();
    const payload = Uint8Array.from([9, 8, 7]);
    writeVisual("sess-1", "pic-1", payload);
    expect([...(readVisual("sess-1", "pic-1") ?? [])]).toEqual([9, 8, 7]);
    expect(statSync(join(root, "visuals", "sess-1", "pic-1")).mode & 0o777).toBe(0o600);
    expect(() => writeVisual("../etc", "passwd", payload)).toThrow(/rejected/);
    expect(readVisual("../etc", "passwd")).toBeNull();
    expect(readVisual("sess-1", "missing")).toBeNull();
    expect([...(decodeVisualBytes(Buffer.from("hi").toString("base64")) ?? [])]).toEqual([104, 105]);
    expect(decodeVisualBytes("not base64!!!!")).toBeNull();
    expect(decodeVisualBytes("data:image/png;base64,aaaa")).toBeNull();
  });
});
