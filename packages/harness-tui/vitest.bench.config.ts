import { defineConfig } from "vitest/config";

const dedupe = ["yjs", "@here.build/plexus", "@here.build/arrival"];

export default defineConfig({
  resolve: { dedupe },
  test: {
    environment: "node",
    include: ["scripts/**/*.bench.ts"],
    fileParallelism: false,
    disableConsoleIntercept: true,
  },
});
