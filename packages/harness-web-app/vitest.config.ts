import { defineConfig } from "vitest/config";

const resolve = { dedupe: ["yjs", "@here.build/plexus", "react", "react-dom", "mobx-react-lite"] };

export default defineConfig({
  resolve,
  test: {
    include: ["src/**/__tests__/**/*.test.ts", "src/**/__visual__/**/*.test.ts"],
    projects: [
      {
        extends: false,
        resolve,
        test: {
          name: "logic",
          environment: "node",
          testTimeout: 30_000,
          hookTimeout: 30_000,
          include: ["src/**/__tests__/**/*.test.ts"],
        },
      },
      {
        extends: false,
        resolve,
        test: {
          name: "visual",
          environment: "node",
          testTimeout: 60_000,
          hookTimeout: 60_000,
          include: ["src/**/__visual__/**/*.test.ts"],
          fileParallelism: false,
        },
      },
    ],
  },
});
