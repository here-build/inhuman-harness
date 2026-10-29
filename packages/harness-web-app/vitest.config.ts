import { defineConfig } from "vitest/config";


export default defineConfig({
  resolve: {
    dedupe: ["yjs", "@here.build/plexus", "react", "react-dom", "mobx-react-lite"],
  },
  test: {
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: ["src/**/__tests__/**/*.test.ts"],
  },
});
