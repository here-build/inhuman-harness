import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The research corpus floor is hermetic: it runs with the rest. Its LM Studio tests stay in `pnpm research`.
    include: ["src/**/__tests__/**/*.test.ts", "src/policy-processor/__research__/floor.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 30_000,
    restoreMocks: true,
  },
});
