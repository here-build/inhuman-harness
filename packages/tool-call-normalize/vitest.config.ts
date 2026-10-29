import { defineConfig } from "vitest/config";

// Whitelist-only include (.claude/rules/tests.md).
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: ["src/__tests__/**/*.test.ts"],
    environment: "node",
    restoreMocks: true,
  },
});
