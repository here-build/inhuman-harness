import { defineConfig } from "vitest/config";

// Atoms are gone. Prefer `pnpm --filter @inhuman.tools/quickdraw test`
// (`package.json` `test:umbrella` now delegates there). This file stays as a
// thin source include so stray `vitest --config vitest.quickdraw.config.ts`
// invocations still hit the fused package.
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    root: import.meta.dirname,
    include: [
      "packages/quickdraw/src/**/*.test.ts",
      "packages/quickdraw/src/**/__tests__/**/*.test.ts",
      "packages/quickdraw/src/**/__test__/**/*.test.ts",
    ],
    // Terminal goldens open real apps. They stay on `pnpm --filter @inhuman.tools/quickdraw visual`.
    exclude: ["packages/quickdraw/src/storybook/**/__visual__/**"],
    environment: "node",
  },
});
