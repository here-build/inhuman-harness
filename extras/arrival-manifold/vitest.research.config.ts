/**
 * Opt-in research suite (`pnpm research`) — spawns a REAL external MCP server over stdio
 * (npx-installed on demand) and drives a real headless browser through it. Slow, network-
 * and npx-dependent, not part of the default `pnpm test` gate. See src/__research__/.
 */
import { defineConfig } from "vitest/config";

// noinspection JSUnusedGlobalSymbols
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 60_000,
    include: ["src/__research__/**/*.test.{ts,tsx}"],
  },
});
