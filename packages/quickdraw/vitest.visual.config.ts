import { defineConfig } from "vitest/config";

/**
 * Mac-only story goldens via the harness terminal driver (not a CI gate).
 *
 *   pnpm --filter @inhuman.tools/quickdraw visual
 *   UPDATE_SCREENSHOTS=1 pnpm --filter @inhuman.tools/quickdraw visual
 */
export default defineConfig({
  test: {
    include: ["src/storybook/**/__visual__/**/*.test.ts"],
    environment: "node",
    setupFiles: ["src/storybook/__visual__/terminal-matcher.ts"],
    // ONE WINDOW: forks + fileParallelism:false. Same law as
    // harness terminals config — two files in parallel share
    // one real Terminal window and goldens race.
    pool: "forks",
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 200_000,
    hookTimeout: 60_000,
  },
});
