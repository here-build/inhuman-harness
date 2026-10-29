import { defineConfig } from "vitest/config";

// Whitelist-only include (.claude/rules/tests.md).
export default defineConfig({
  test: {
    include: ["src/__tests__/**/*.test.ts"],
    environment: "node",
    restoreMocks: true,
  },
});
