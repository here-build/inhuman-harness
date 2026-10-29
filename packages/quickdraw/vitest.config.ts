import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    environment: "node",
    restoreMocks: true,
    projects: [
      {
        test: {
          testTimeout: 30_000,
          hookTimeout: 30_000,
          name: "logic",
          environment: "node",
          restoreMocks: true,
          include: ["src/**/__tests__/**/*.test.ts", "src/**/__e2e__/**/*.test.ts"],
          exclude: ["src/storybook/**"],
        },
      },
      {
        test: {
          testTimeout: 30_000,
          hookTimeout: 30_000,
          name: "storybook",
          environment: "node",
          restoreMocks: true,
          include: ["src/storybook/**/__tests__/**/*.test.ts"],
          // Native headless-gl self-registers once per process — vitest's default
          // worker threads break it ("Module did not self-register"); forked
          // processes load it fine. Needed by fx-materialize.test.ts.
          pool: "forks",
        },
      },
      {
        test: {
          testTimeout: 30_000,
          hookTimeout: 30_000,
          name: "visual",
          environment: "node",
          restoreMocks: true,
          include: ["src/**/__visual__/**/*.test.ts"],
          // Terminal goldens live in vitest.visual.config.ts (mac apps, not CI).
          exclude: ["src/storybook/**"],
        },
      },
    ],
  },
});
