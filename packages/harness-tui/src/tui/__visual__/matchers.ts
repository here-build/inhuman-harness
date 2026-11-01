/**
 * Journey frame for a visual walk. The picture comes from `qd dump`.
 * A Buffer is a frame the JS raster already painted (a scroll override).
 * A checked-in structural frame is the approval oracle. Recording the
 * optional journey cannot turn an unknown or changed frame green.
 */
import { expect } from "vitest";

import { presentDump } from "../present-visual/dump.js";
import { noteBeat, notePng } from "../present-visual/journey.js";
import type { Tea } from "../tea.js";
import { dumpPaint } from "./_helpers.js";

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

// Paint replica IDs depend on allocation order; they are not user-visible.
// Preserve public picker keys, which express selection and duplicate identities.
function approvalFrame(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(approvalFrame);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, field]) => !(key === "key" && typeof field === "string" && field.includes("paint:")))
      .map(([key, field]) => [key, approvalFrame(field)]),
  );
}

expect.extend({
  toMatchScreenshot(received: unknown, name: string) {
    if (!nameOk(name)) {
      return {
        pass: false,
        message: () => `screenshot name must be kebab-case, got ${JSON.stringify(name)}`,
      };
    }
    const tea = teaOf(received);
    if (tea !== undefined) {
      const frame = isRecord(received) && typeof received.dump === "function" ? received.dump() : dumpPaint(tea);
      expect(approvalFrame(frame)).toMatchSnapshot(name);
      if (process.env.RECORD_PRESENT === "1") {
        return presentDump(tea).then(async (dump) => {
          await noteBeat(name, dump, tea.cols, tea.rows, true, []);
          return { pass: true, message: () => `approved structural frame ${name}` };
        });
      }
      return { pass: true, message: () => `approved structural frame ${name}` };
    }
    if (isRecord(received) && Buffer.isBuffer(received.png) && "frame" in received) {
      expect(approvalFrame(received.frame)).toMatchSnapshot(name);
      if (process.env.RECORD_PRESENT === "1")
        return notePng(name, received.png, true, []).then(() => ({
          pass: true,
          message: () => `approved structural frame ${name}`,
        }));
      return { pass: true, message: () => `approved structural frame ${name}` };
    }
    return {
      pass: false,
      message: () => "toMatchScreenshot expects openTea() or screenshot() with its structural frame",
    };
  },
});

declare module "vitest" {
  // Augment `Matchers`, which both `Assertion` and `AsymmetricMatchersContaining` extend.
  // The type parameters must match vitest's declaration exactly or the merge fails.

  // noinspection JSUnusedGlobalSymbols
  interface Matchers<R extends void | Promise<void> = void | Promise<void>, T = unknown> {
    toMatchScreenshot(name: string): R;
  }
}
