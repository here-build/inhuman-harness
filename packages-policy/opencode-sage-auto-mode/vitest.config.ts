import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@inhuman\.tools\/policy$/,
        replacement: path.join(here, "../policy/dist/index.js"),
      },
      {
        find: /^@inhuman\.tools\/arrival$/,
        replacement: path.join(here, "../policy/node_modules/@here.build/arrival/dist/index.js"),
      },
    ],
  },
  test: {
    include: ["src/__tests__/**/*.test.ts"],
    environment: "node",
    restoreMocks: true,
  },
});
