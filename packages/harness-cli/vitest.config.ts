import { defineConfig } from "vitest/config";

// The in-process tests run the core's daemon from its dist beside the sdk and the model.
// SessionTurn extends Job (jobs dist -> plexus). One Y.Doc constructor.
const dedupe = ["yjs", "@here.build/plexus", "@here.build/arrival"];

function packageResolve() {
  return { dedupe };
}

export default defineConfig({
  resolve: packageResolve(),
  test: {
    environment: "node",
    restoreMocks: true,
    // `projects` alone leaves the top-level include unset, so IDE integrations
    // that read config.test.include discover nothing. Vitest still runs only
    // the named projects.
    // Whitelist. __process__ is Large: it spawns dist/bin.js.
    // A new src/<area>/__tests__ directory stays out of logic until it is listed.
    include: ["src/**/__tests__/**/*.test.ts", "src/**/__process__/**/*.test.ts"],
    projects: [
      {
        resolve: packageResolve(),
        test: {
          name: "logic",
          environment: "node",
          restoreMocks: true,
          include: ["src/cli/**/__tests__/**/*.test.ts", "src/eval/__tests__/**/*.test.ts"],
        },
      },
      {
        resolve: packageResolve(),
        test: {
          name: "process",
          environment: "node",
          restoreMocks: true,
          include: ["src/eval/__process__/**/*.test.ts"],
        },
      },
    ],
  },
});
