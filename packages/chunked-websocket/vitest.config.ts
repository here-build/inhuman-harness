import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 30_000,
    restoreMocks: true,
    include: ["src/**/__tests__/**/*.test.ts"],
  },
});
