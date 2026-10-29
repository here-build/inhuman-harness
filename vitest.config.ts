import { defineConfig } from "vitest/config";

import { vitestAliases } from "./packages/harness/scripts/src-alias.mjs";

// Logic gate only. Visual lives in __visual__, Large tests in __process__,
// research in package research configs. Those directories are outside this
// include, so a root `vitest` run does not paint frames or spawn daemons.
// Per-package `pnpm test` is the CI entry. Harness logic is a directory
// whitelist in packages/harness/vitest.config.ts.
export default defineConfig({
  resolve: { alias: vitestAliases() },
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: [
      "packages/*/src/**/__tests__/**/*.test.ts",
      "packages-runtime/substrate/src/**/__tests__/**/*.test.ts",
      "extras/*/src/**/__tests__/**/*.test.ts",
    ],
    environment: "node",
  },
});
