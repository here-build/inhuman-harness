/**
 * Multi-terminal visual goldens for the full story golden matrix.
 *
 * Not a CI gate — run on a Mac with terminal apps installed (terminal zoo):
 *
 *   pnpm --filter @inhuman.tools/quickdraw visual
 *   UPDATE_SCREENSHOTS=1 pnpm --filter @inhuman.tools/quickdraw visual
 *
 * Matrix = every story × sampleCount × tickSnapshots (see golden-matrix.ts).
 *
 * Filters (optional):
 *   STORYBOOK_VISUAL_STORY=w-multiline|md-
 *   STORYBOOK_VISUAL_CATEGORY=widgets|theme|expand|buffer
 *   (retired tags markdown/highlight/diff/paint still alias)
 *   STORYBOOK_VISUAL_TERMINALS=kitty,ghostty   (subset of installed apps)
 *
 * Goldens land at:
 *   src/storybook/__visual__/__screenshots__/storybook/<terminal>/<slug>.png
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// Source import, not a workspace dependency. Harness already depends on
// this package; the reverse edge is a turbo cycle.
import "./terminal-matcher.js";
import {
  availableTerminalsTable,
  isCI,
  isDarwin,
  runTerminalScenarioDetached,
  type TerminalMeta,
} from "../../../../harness-tui/src/e2e/index.js";
import { CATALOG } from "../catalog.js";
import { expandGoldenMatrix, filterGoldenMatrix, goldenMatrixFilterFromEnv } from "../golden-matrix.js";

const here = dirname(fileURLToPath(import.meta.url));
const storybookRoot = join(here, "..");
const pkgRoot = join(storybookRoot, "../..");
const fixtureTs = join(storybookRoot, "fixtures/story-demo.ts");
const screenshotsRoot = join(here, "__screenshots__");

const darwin = isDarwin();
const fixtureReady = existsSync(fixtureTs);

if (!darwin) console.warn("[storybook visual] non-darwin — skip");
if (darwin && !fixtureReady) {
  console.warn(`[storybook visual] missing ${fixtureTs}`);
}

/** Optional allow-list: STORYBOOK_VISUAL_TERMINALS=kitty,ghostty */
function filterTerminals(all: TerminalMeta[]): TerminalMeta[] {
  const raw = process.env["STORYBOOK_VISUAL_TERMINALS"]?.trim();
  if (!raw) return all;
  const want = new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  return all.filter((t) => want.has(t.id.toLowerCase()) || want.has(t.label.toLowerCase()));
}

const terminals: TerminalMeta[] = darwin && fixtureReady ? filterTerminals(await availableTerminalsTable()) : [];

const matrix = filterGoldenMatrix(expandGoldenMatrix(CATALOG), goldenMatrixFilterFromEnv());

/** First frame: no step (fixture already paints matrix[0]). Then step to each later cell. */
const STEPS = matrix.map((s, i) =>
  i === 0
    ? {
        name: s.name,
        step: undefined as string | undefined,
        settleMs: 700,
      }
    : {
        name: s.name,
        step: s.name,
        settleMs: 450,
      },
);

const shQuote = (p: string) => `'${p.replaceAll("'", String.raw`'\''`)}'`;

// Ensure screenshots tree exists (gitkeep for empty suite)
mkdirSync(join(screenshotsRoot, "storybook"), { recursive: true });

const perTerminalTimeoutMs = Math.max(
  240_000,
  // ~0.6s settle + overhead per state, plus open/close
  90_000 + matrix.length * 900,
);

describe.skipIf(isCI() || !darwin || !fixtureReady || terminals.length === 0 || matrix.length === 0)(
  "quickdraw storybook goldens (full matrix)",
  () => {
    it("matrix is non-empty and unique", () => {
      expect(matrix.length).toBeGreaterThan(0);
      const names = matrix.map((s) => s.name);
      expect(new Set(names).size).toBe(names.length);
    });

    it.each(terminals)(
      `$label ($id) — ${matrix.length} matrix states`,
      async (terminal) => {
        // One driver session walks the entire matrix (stable window geometry).
        // Short argv only: 60+ --story flags blew up Ghostty/login -lc. The
        // fixture expands CATALOG (+ STORYBOOK_VISUAL_* env filters inherited
        // via the driver). STEPS still step every matrix slug over TCP.
        const { shots } = await runTerminalScenarioDetached({
          terminal: terminal.id,
          cwd: pkgRoot,
          command: `pnpm exec tsx ${shQuote(fixtureTs)} --control {{control}}`,
          steps: STEPS,
          timeoutMs: perTerminalTimeoutMs,
        });

        expect(shots.length).toBe(STEPS.length);

        for (const shot of shots) {
          expect(shot.png).toMatchTerminalGolden({
            suite: "storybook",
            terminal: terminal.id,
            name: shot.name,
            // Multi-term zoo: slightly looser than buffer micro-suite
            maxDiffRatio: 0.03,
            screenshotsRoot,
          });
        }
      },
      perTerminalTimeoutMs + 30_000,
    );
  },
);

describe.skipIf(isCI() || !darwin || !fixtureReady || terminals.length > 0)(
  "quickdraw storybook goldens (no apps)",
  () => {
    it("requires a terminal app", () => {
      expect(terminals.length).toBeGreaterThan(0);
    });
  },
);

describe.skipIf(isCI() || !darwin || !fixtureReady || matrix.length > 0)(
  "quickdraw storybook goldens (empty matrix)",
  () => {
    it("matrix filter left no states", () => {
      expect(matrix.length).toBeGreaterThan(0);
    });
  },
);
