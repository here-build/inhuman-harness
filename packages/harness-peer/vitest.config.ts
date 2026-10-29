import { defineConfig } from "vitest/config";

// One Y.Doc and one Plexus constructor across the workspace symlinks.
const dedupe = ["yjs", "@here.build/plexus"];

export default defineConfig({
  resolve: { dedupe },
  test: {
    environment: "node",
    restoreMocks: true,
    include: ["src/**/__tests__/**/*.test.ts"],
  },
});
