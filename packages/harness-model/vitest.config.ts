import { defineConfig } from "vitest/config";

const dedupe = ["yjs", "@here.build/plexus"];

export default defineConfig({
  resolve: { dedupe },
  test: {
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 30_000,
    restoreMocks: true,
    include: ["src/**/__tests__/**/*.test.ts"],
  },
});
