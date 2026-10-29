/**
 * Vitest 4 golden matcher for the story catalog.
 *
 * Compare lives in the harness terminal driver. Each package has its own
 * vitest install, so this file extends the quickdraw copy. A workspace
 * dependency on harness would cycle turbo (harness already depends on
 * quickdraw).
 */

import { dirname, join } from "node:path";

import { expect } from "vitest";

import { matchGolden } from "../../../../harness-tui/src/e2e/compare.js";
import type { TerminalId } from "../../../../harness-tui/src/e2e/index.js";

export type TerminalGoldenOpts = {
  suite: string;
  terminal: TerminalId;
  name: string;
  screenshotsRoot?: string;
  maxDiffRatio?: number;
  threshold?: number;
  cornerRadius?: number;
  ignoreRegions?: readonly { x: number; y: number; width: number; height: number }[];
};

function defaultScreenshotsRoot(): string {
  const testPath = expect.getState().testPath;
  if (testPath) return join(dirname(testPath), "__screenshots__");
  return join(process.cwd(), "src/__visual__/__screenshots__");
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
      return { pass: true, message: () => `Wrote golden ${goldenPath}` };
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
              }\n  golden: ${goldenPath}\n  record: UPDATE_SCREENSHOTS=1 pnpm visual`
            : `Terminal golden differs: ${opts.terminal}/${opts.name} ` +
              `diffRatio=${result.diffRatio.toFixed(4)} ` +
              `(diffPixels=${result.diffPixels}/${result.totalPixels}` +
              `, masked=${result.maskedPixels})${result.actualPath ? ` actual=${result.actualPath}` : ""}${
                result.diffPath ? ` diff=${result.diffPath}` : ""
              }\n  golden: ${goldenPath}\n  re-record: UPDATE_SCREENSHOTS=1 pnpm visual`,
    };
  },
});

declare module "vitest" {
  // Type parameter name has to match vitest's `Assertion<T>` or the merge fails.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface Assertion<T> {
    toMatchTerminalGolden(opts: TerminalGoldenOpts): void;
  }
  interface AsymmetricMatchersContaining {
    toMatchTerminalGolden(opts: TerminalGoldenOpts): void;
  }
}
