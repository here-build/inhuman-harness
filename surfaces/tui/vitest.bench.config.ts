import { defineConfig } from "vitest/config";

const dedupe = ["@inhuman.tools/model"];

export default defineConfig({
  resolve: { dedupe },
  test: {
    environment: "node",
    include: ["scripts/**/*.bench.ts"],
    fileParallelism: false,
    disableConsoleIntercept: true,
  },
});
