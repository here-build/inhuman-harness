import { defineConfig } from "vitest/config";

// hosted-extraction.test.ts boots the daemon from the core's source, which still says `@/`.
import { vitestAliases } from "../../packages/harness/scripts/src-alias.mjs";

const dedupe = ["mobx", "@here.build/plexus"];

export default defineConfig({
  resolve: { alias: vitestAliases(), dedupe },
  test: {
    environment: "node",
    include: ["src/**/__tests__/**/*.test.ts"],
    pool: "forks",
    fileParallelism: false,
    testTimeout: 15_000,
  },
});
