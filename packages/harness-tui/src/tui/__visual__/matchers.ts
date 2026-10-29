/**
 * Journey frame for a visual walk. The picture comes from `qd dump`.
 * A Buffer is a frame the JS raster already painted (a scroll override).
 * Pixel goldens are not the assertion.
 */
import { expect } from "vitest";

import { presentDump } from "../present-visual/dump.js";
import { noteBeat, notePng } from "../present-visual/journey.js";
import type { Tea } from "../tea.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTea(value: unknown): value is Tea {
  return isRecord(value) && typeof value.flushPaint === "function" && "paintRoot" in value;
}

function teaOf(received: unknown): Tea | undefined {
  if (isTea(received)) return received;
  if (isRecord(received) && isTea(received.tea)) return received.tea;
  return undefined;
}

function nameOk(name: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name);
}

function isPng(buf: Buffer): boolean {
  return buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
}

expect.extend({
  async toMatchScreenshot(received: unknown, name: string) {
    if (!nameOk(name)) {
      return {
        pass: false,
        message: () => `screenshot name must be kebab-case, got ${JSON.stringify(name)}`,
      };
    }
    const tea = teaOf(received);
    if (tea !== undefined) {
      const dump = await presentDump(tea);
      await noteBeat(name, dump, tea.cols, tea.rows, true, []);
      return { pass: true, message: () => `journey ${name}` };
    }
    if (Buffer.isBuffer(received) && isPng(received)) {
      await notePng(name, received, true, []);
      return { pass: true, message: () => `journey ${name}` };
    }
    return {
      pass: false,
      message: () => "toMatchScreenshot expects openTea() or a PNG Buffer",
    };
  },
});

declare module "vitest" {
  // noinspection JSUnusedGlobalSymbols
  interface Assertion<T> {
    toMatchScreenshot(name: string): T;
  }
  // noinspection JSUnusedGlobalSymbols
  interface AsymmetricMatchersContaining {
    toMatchScreenshot(name: string): void;
  }
}
