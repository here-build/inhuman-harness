import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    environment: "node",
    restoreMocks: true,
    include: ["src/**/__tests__/**/*.test.ts"],
  },
});
