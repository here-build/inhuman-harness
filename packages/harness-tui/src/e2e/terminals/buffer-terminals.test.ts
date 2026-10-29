/**
 * Buffer paint behavioral screenshots — driver runs in a child process (execa).
 *
 * Vitest never opens terminals or writes CSI; the driver child does all of that
 * with stdio fully piped.
 *
 *   pnpm --filter @inhuman.tools/harness-tui terminals
 *   UPDATE_SCREENSHOTS=1 pnpm --filter @inhuman.tools/harness-tui terminals
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { isCI } from "../ci.js";
import { runTerminalScenarioDetached } from "../driver/client.js";
import { isDarwin } from "../mac.js";
import type { TerminalMeta } from "../terminals.js";
import { availableTerminalsTable } from "../vitest/terminals-table.js";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "../../..");
const fixtureTs = join(here, "../fixtures/buffer-demo.ts");
const tsxLoader = createRequire(import.meta.url).resolve("tsx");

const darwin = isDarwin();
const fixtureReady = existsSync(fixtureTs);

if (!darwin) {
  console.warn("[terminal-e2e] non-darwin — skipping (mac-only)");
}
if (darwin && !fixtureReady) {
  console.warn(`[terminal-e2e] missing ${fixtureTs}`);
}

const terminals: TerminalMeta[] = darwin && fixtureReady ? await availableTerminalsTable() : [];

if (darwin && fixtureReady && terminals.length === 0) {
  console.warn("[terminal-e2e] no terminal apps detected");
}

const STEPS = [
  { name: "01-initial", step: undefined as string | undefined, settleMs: 700 },
  { name: "02-dirty-row", step: "dirty-row", settleMs: 500 },
  { name: "03-truecolor", step: "truecolor", settleMs: 500 },
  { name: "04-wide-cjk", step: "wide-cjk", settleMs: 500 },
];

const shQuote = (p: string) => `'${p.replaceAll("'", `'\\''`)}'`;

describe.skipIf(isCI() || !darwin || !fixtureReady || terminals.length === 0)("buffer terminal screenshots", () => {
  // One vitest test per terminal — driver child runs the step sequence.
  it.each(terminals)(
    "$label ($id)",
    async (terminal) => {
      const { shots } = await runTerminalScenarioDetached({
        terminal: terminal.id,
        cwd: pkgRoot,
        command: `node --import ${shQuote(tsxLoader)} ${shQuote(fixtureTs)} --control {{control}}`,
        steps: STEPS,
        timeoutMs: 180_000,
      });

      expect(shots.length).toBe(STEPS.length);

      for (const shot of shots) {
        expect(shot.png).toMatchTerminalGolden({
          suite: "buffer",
          terminal: terminal.id,
          name: shot.name,
          maxDiffRatio: 0.02,
        });
      }
    },
    200_000,
  );
});

describe.skipIf(isCI() || !darwin || !fixtureReady || terminals.length > 0)(
  "buffer terminal screenshots (no apps)",
  () => {
    it("requires at least one terminal app", () => {
      expect(terminals.length).toBeGreaterThan(0);
    });
  },
);
