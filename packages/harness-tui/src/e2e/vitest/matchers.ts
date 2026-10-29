/**
 * Vitest `expect` extensions for terminal goldens (pixelmatch + UPDATE_SCREENSHOTS).
 *
 * Loaded via setupFiles in vitest.visual.config.ts — same shape as
 * mercury-interpreter's toMatchScreenshot, but for PNG buffers from
 * screencapture rather than Playwright.
 */

import { dirname, join } from "node:path";

import { expect } from "vitest";

import { matchGolden } from "../compare.js";
import type { Rect } from "../screenshot.js";
import type { TerminalId } from "../terminals-types.js";

export type TerminalGoldenOpts = {
  /** Suite folder under __screenshots__ (e.g. "buffer", "widgets"). */
  suite: string;
  terminal: TerminalId;
  /** Step slug, e.g. "01-initial". */
  name: string;
  /**
   * Absolute directory that contains `__screenshots__/`.
   * Default: dirname of the current test file's suite root passed by caller,
   * or `expect.getState().testPath` parent + `__screenshots__` when omitted
   * and testPath is under `src/e2e/terminals/`.
   */
  screenshotsRoot?: string;
  maxDiffRatio?: number;
  threshold?: number;
  /**
   * Rounded-corner mask radius in device px. Defaults to
   * `DEFAULT_CORNER_RADIUS` — the capture is rectangular but the window is
   * not, so those pixels are desktop wallpaper. 0 disables.
   */
  cornerRadius?: number;
  /** Extra device-px rectangles to exclude (clocks, titles, anything live). */
  ignoreRegions?: readonly Rect[];
};

function defaultScreenshotsRoot(): string {
  const testPath = expect.getState().testPath;
  if (testPath) {
    // …/src/e2e/terminals/foo.test.ts → …/src/e2e/terminals/__screenshots__
    return join(dirname(testPath), "__screenshots__");
  }
  return join(process.cwd(), "src/e2e/terminals/__screenshots__");
}

expect.extend({
  toMatchTerminalGolden(received: Buffer, opts: TerminalGoldenOpts) {
    if (!Buffer.isBuffer(received)) {
      return {
        pass: false,
        message: () => `toMatchTerminalGolden expects a PNG Buffer, got ${typeof received}`,
      };
    }
    const root = opts.screenshotsRoot ?? defaultScreenshotsRoot();
    const goldenPath = join(root, opts.suite, opts.terminal, `${opts.name}.png`);
    const result = matchGolden(received, {
      goldenPath,
      maxDiffRatio: opts.maxDiffRatio ?? 0.02,
      threshold: opts.threshold,
      artifactDir: dirname(goldenPath),
      cornerRadius: opts.cornerRadius,
      ignoreRegions: opts.ignoreRegions,
    });

    if (result.updated) {
      return {
        pass: true,
        message: () => `Wrote golden ${goldenPath}`,
      };
    }

    const missing = !result.pass && result.diffRatio === 1 && result.totalPixels === 0 && !result.diffPath;

    return {
      pass: result.pass,
      message: () =>
        result.pass
          ? `Terminal golden matches: ${opts.terminal}/${opts.name}`
          : missing
            ? `Terminal golden missing: ${opts.terminal}/${opts.name}${
                result.actualPath ? ` actual=${result.actualPath}` : ""
              }\n  golden: ${goldenPath}` +
              `\n  record: UPDATE_SCREENSHOTS=1 pnpm --filter @inhuman.tools/harness-tui terminals`
            : `Terminal golden differs: ${opts.terminal}/${opts.name} ` +
              `diffRatio=${result.diffRatio.toFixed(4)} ` +
              `(diffPixels=${result.diffPixels}/${result.totalPixels}` +
              `, masked=${result.maskedPixels})${result.actualPath ? ` actual=${result.actualPath}` : ""}${
                result.diffPath ? ` diff=${result.diffPath}` : ""
              }\n  golden: ${goldenPath}` +
              `\n  re-record: UPDATE_SCREENSHOTS=1 pnpm --filter @inhuman.tools/harness-tui terminals`,
    };
  },
});

declare module "vitest" {
  // Match vitest's Assertion type params (no default) so augmentation merges.

  // noinspection JSUnusedGlobalSymbols
  interface Assertion<T> {
    toMatchTerminalGolden(opts: TerminalGoldenOpts): void;
  }
  // noinspection JSUnusedGlobalSymbols
  interface AsymmetricMatchersContaining {
    toMatchTerminalGolden(opts: TerminalGoldenOpts): void;
  }
}
