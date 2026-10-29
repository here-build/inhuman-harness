import { defineConfig } from "vitest/config";

const dedupe = ["yjs", "@here.build/plexus", "@here.build/arrival"];

export default defineConfig({
  resolve: { dedupe },
  test: {
    environment: "node",
    restoreMocks: true,
    include: ["src/**/__tests__/**/*.test.ts"],
  },
});
