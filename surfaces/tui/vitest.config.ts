import { defineConfig } from "vitest/config";

const dedupe = ["@inhuman.tools/model"];

function packageResolve() {
  return {
    dedupe,
  };
}

export default defineConfig({
  resolve: packageResolve(),
  test: {
    environment: "node",
    restoreMocks: true,
    include: ["src/**/__tests__/**/*.test.ts"],
    projects: [
      {
        // Vitest 5 merges the root config into inline projects by default; keep each project on its own include.
        extends: false,
        resolve: packageResolve(),
        test: {
          name: "logic",
          environment: "node",
          restoreMocks: true,
          include: [
            "src/interpreter/**/__tests__/**/*.test.ts",
            "src/tui/__tests__/**/*.test.ts",
          ],
        },
      },
    ],
  },
});
