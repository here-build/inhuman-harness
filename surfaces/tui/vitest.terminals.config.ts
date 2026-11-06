import { defineConfig } from "vitest/config";

/**
 * Mac-only real-terminal screenshots (osascript + screencapture). Not a CI gate.
 * Loud-skips on non-darwin or when no terminal app is installed.
 *
 * Kept off the `visual` project: that project is the in-process TUI golden
 * gate (`pnpm test:visual` / root verify).
 *
 *   pnpm --filter @inhuman.tools/harness-tui terminals
 *   UPDATE_SCREENSHOTS=1 pnpm --filter @inhuman.tools/harness-tui terminals
 */
export default defineConfig({
  test: {
    include: ["src/e2e/terminals/**/*.test.ts"],
    environment: "node",
    // Side-effect: expect.extend(toMatchTerminalGolden) + darwin warn
    setupFiles: ["src/e2e/vitest/setup.ts"],
    // Isolate from suite TTY: forks + no file parallelism (one window at a time)
    pool: "forks",
    testTimeout: 120_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    sequence: { concurrent: false },
    // Verbose path updates use less cursor-up thrash than the default progress UI
    // when a rogue CSI still hits this TTY; prefer a clean reporter.
    reporters: process.env["TERMINAL_E2E_VERBOSE"] === "1" ? ["verbose"] : ["default"],
  },
});
