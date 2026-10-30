import { defineConfig } from "vitest/config";

// Real processes: `wrangler dev` plus a daemon. Not part of `test`; run with `pnpm test:e2e`.
export default defineConfig({
  resolve: { dedupe: ["yjs"] },
  test: {
    environment: "node",
    include: ["e2e/**/*.e2e.test.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
