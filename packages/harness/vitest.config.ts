import { defineConfig } from "vitest/config";

import { vitestAliases } from "./scripts/src-alias.mjs";

const dedupe = ["yjs", "@here.build/plexus", "@here.build/arrival"];

const alias = vitestAliases();

function packageResolve() {
  return {
    alias,
    // SessionTurn extends Job (jobs dist → plexus). One Y.Doc constructor.
    dedupe,
  };
}

const serverPool = {
  pool: "forks" as const,
  fileParallelism: false,
  testTimeout: 15_000,
  hookTimeout: 15_000,
};

export default defineConfig({
  resolve: packageResolve(),
  test: {
    environment: "node",
    restoreMocks: true,
    // `projects` alone leaves the top-level include unset, so IDE integrations
    // that read config.test.include discover nothing. Vitest still runs only
    // the named projects.
    // Whitelist. __process__ is Large. The TUI's projects live in
    // packages/harness-tui/vitest.config.ts, the CLI's in packages/harness-cli/vitest.config.ts.
    // A new src/<area>/__tests__ directory stays out of logic until it is listed.
    include: ["src/**/__tests__/**/*.test.ts", "src/**/__process__/**/*.test.ts"],
    projects: [
      {
        resolve: packageResolve(),
        test: {
          name: "logic",
          environment: "node",
          restoreMocks: true,
          include: [
            "src/__tests__/**/*.test.ts",
            "src/builtin-tools/**/__tests__/**/*.test.ts",
            "src/connections/**/__tests__/**/*.test.ts",
            "src/extensions/**/__tests__/**/*.test.ts",
            "src/hypervisor/**/__tests__/**/*.test.ts",
            "src/protocol/**/__tests__/**/*.test.ts",
            "src/providers/**/__tests__/**/*.test.ts",
            "src/runtime/**/__tests__/**/*.test.ts",
            "src/runtime-server/**/__tests__/**/*.test.ts",
            "src/tool-runtime/**/__tests__/**/*.test.ts",
            "src/yjs/**/__tests__/**/*.test.ts",
          ],
        },
      },
      {
        resolve: packageResolve(),
        test: {
          name: "server",
          environment: "node",
          restoreMocks: true,
          ...serverPool,
          include: ["src/server/**/__tests__/**/*.test.ts"],
        },
      },
      {
        resolve: packageResolve(),
        test: {
          name: "server-process",
          environment: "node",
          restoreMocks: true,
          ...serverPool,
          include: ["src/server/__process__/**/*.test.ts"],
        },
      },
      {
        resolve: packageResolve(),
        test: {
          name: "research",
          environment: "node",
          restoreMocks: true,
          include: [
            "../../packages-runtime/turn/src/policy-processor/__research__/**/*.test.ts",
          ],
          fileParallelism: false,
          testTimeout: 10_800_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
