import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const here = dirname(fileURLToPath(import.meta.url));
const dedupe = ["yjs", "@here.build/plexus", "@here.build/arrival"];

function packageResolve() {
  return {
    // SessionTurn extends Job (jobs dist → plexus). One Y.Doc constructor.
    dedupe,
  };
}

export default defineConfig({
  resolve: packageResolve(),
  test: {
    environment: "node",
    restoreMocks: true,
    // `projects` alone leaves the top-level include unset, so IDE integrations
    // that read config.test.include discover nothing. Vitest still runs only
    // the named projects.
    // Whitelist. present-visual is the visual project. __process__ is Large.
    // Paint imports and structural approvals live in the visual project.
    // A new src/<area>/__tests__ directory stays out of logic until it is listed.
    include: ["src/**/__tests__/**/*.test.ts", "src/tui/__visual__/**/*.test.ts", "src/tui/present-visual/**/*.test.ts"],
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
            "src/e2e/**/__tests__/**/*.test.ts",
            "src/interpreter/**/__tests__/**/*.test.ts",
            "src/tui/__tests__/**/*.test.ts",
          ],
        },
      },
      {
        // Vitest 5 merges the root config into inline projects by default; keep each project on its own include.
        extends: false,
        resolve: packageResolve(),
        test: {
          name: "visual",
          environment: "node",
          restoreMocks: true,
          include: ["src/tui/present-visual/**/*.test.ts", "src/tui/__visual__/**/*.test.ts"],
          // Real-terminal goldens live under src/e2e and open Mac apps.
          // They run via vitest.terminals.config.ts, not this CI gate.
          exclude: ["src/e2e/**"],
          testTimeout: 30_000,
          hookTimeout: 30_000,
          env: { TZ: "UTC" },
          setupFiles: [join(here, "src/tui/__visual__/matchers.ts")],
          globalSetup: join(here, "src/tui/present-visual/journey-teardown.ts"),
        },
      },
    ],
  },
});
