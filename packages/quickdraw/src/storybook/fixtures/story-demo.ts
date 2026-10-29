/**
 * Real-terminal scenario: paint every golden-matrix state full-bleed.
 *
 *   TERMINAL_E2E=1 pnpm exec tsx src/storybook/fixtures/story-demo.ts --control host:port \
 *     [--story slug-or-id]...
 *
 * Step names are matrix slugs: `{storyId}__s{sample}__t{tick}`
 * (also accepts bare story id → s0/t0).
 *
 * Default story list: full golden matrix from CATALOG.
 * Env filters (same as visual suite): STORYBOOK_VISUAL_{STORY,CATEGORY}
 */

import { execFileSync } from "node:child_process";
import { openSync, writeSync, closeSync } from "node:fs";
import { createConnection } from "node:net";

import { cloneBuffer, emitAnsi, type Buffer as CellBuffer } from "../../buffer/index.js";
import {
  bufferHasBgFx,
  materializeBgFx,
  registerShadertoyCatalog,
  shadertoyGlAvailable,
} from "../../internals/bgfx/index.js";
import { FgP } from "../../lexicon/index.js";
import { Text } from "../../widgets/index.js";
import { CATALOG, getStory } from "../catalog.js";
import {
  expandGoldenMatrix,
  filterGoldenMatrix,
  goldenMatrixFilterFromEnv,
  parseGoldenSlug,
} from "../golden-matrix.js";
import { paintNode } from "../render.js";
import { Panel } from "../stories/demo-atoms.js";
import type { GoldenState } from "../types.js";

/** Frozen geometry — must match visual suite expectations. */
export const GOLDEN_COLS = 56;
export const GOLDEN_ROWS = 18;

function parseArgs(): {
  host: string;
  port: number;
  /** Ordered matrix states to photograph */
  states: GoldenState[];
} {
  if (process.env["TERMINAL_E2E"] !== "1") {
    console.error("story-demo: TERMINAL_E2E=1 required");
    process.exit(2);
  }
  const i = process.argv.indexOf("--control");
  if (i === -1 || !process.argv[i + 1]) {
    console.error("usage: story-demo --control host:port [--story slug|id]...");
    process.exit(2);
  }
  const [host, portStr] = process.argv[i + 1]!.split(":");
  const port = Number(portStr);
  if (!host || !Number.isFinite(port)) {
    console.error("bad --control");
    process.exit(2);
  }

  const requested: string[] = [];
  for (let k = 0; k < process.argv.length; k++) {
    if (process.argv[k] === "--story" && process.argv[k + 1]) {
      requested.push(process.argv[k + 1]!);
    }
  }

  const full = filterGoldenMatrix(expandGoldenMatrix(CATALOG), goldenMatrixFilterFromEnv());

  let states: GoldenState[];
  if (requested.length === 0) {
    states = full;
  } else {
    states = [];
    for (const raw of requested) {
      const parsed = parseGoldenSlug(raw);
      if (!parsed) {
        console.error(`bad --story ${raw}`);
        process.exit(2);
      }
      if (!getStory(parsed.storyId)) {
        console.error(`unknown story ${parsed.storyId}`);
        process.exit(2);
      }
      // If bare id, expand all matrix cells for that story
      if (raw.includes("__s")) {
        states.push({
          name: raw.includes("__s") ? raw : `${parsed.storyId}__s${parsed.sample}__t${parsed.tick}`,
          storyId: parsed.storyId,
          sample: parsed.sample,
          tick: parsed.tick,
          category: getStory(parsed.storyId)!.category,
        });
      } else {
        states.push(...full.filter((s) => s.storyId === parsed.storyId));
      }
    }
  }

  if (states.length === 0) {
    console.error("story-demo: empty golden matrix after filters");
    process.exit(2);
  }

  return { host, port: port!, states };
}

let paintFd: number | null = null;
let restoreTTY = (): void => {};
function paint(s: string): void {
  if (paintFd === null) {
    try {
      paintFd = openSync("/dev/tty", "w");
    } catch {
      paintFd = 1;
    }
  }
  writeSync(paintFd, s);
}

/**
 * Cooked echo prints ESC as `^[` (ECHOCTL). Alt+Left arrives as `CSI 1;3D`
 * and shows up as the text `^[[1;3D` at the cursor, which sits past the
 * 56-column grid on a row later frames often do not clear.
 */
function silenceTTYEcho(): () => void {
  let saved: string[] = [];
  try {
    saved = execFileSync("stty", ["-f", "/dev/tty", "-g"], { encoding: "utf8" }).trim().split(/\s+/).filter(Boolean);
    execFileSync("stty", ["-f", "/dev/tty", "-echo", "-echoctl"]);
  } catch {
    return () => {};
  }
  return () => {
    if (saved.length === 0) return;
    try {
      execFileSync("stty", ["-f", "/dev/tty", ...saved]);
    } catch {
      /* process is exiting */
    }
  };
}
function paintClose(): void {
  if (paintFd !== null && paintFd !== 1) {
    try {
      closeSync(paintFd);
    } catch {
      /* ignore */
    }
  }
  paintFd = null;
}

function renderState(state: GoldenState): CellBuffer {
  const story = getStory(state.storyId);
  if (!story) {
    return paintNode(Text(`unknown story: ${state.storyId}`), GOLDEN_COLS, GOLDEN_ROWS);
  }
  const node = story.build({
    cols: GOLDEN_COLS - 2,
    rows: GOLDEN_ROWS - 2,
    tick: state.tick,
    sample: state.sample,
  });
  // Full-bleed box so goldens have stable chrome (title row + content)
  const buf = paintNode(
    Panel(
      [
        Text(`${story.category} · ${state.name}`, {
          style: {
            role: "foreground",
            prominence: FgP.secondary,
          },
        }),
        node,
      ],
      { width: GOLDEN_COLS, height: GOLDEN_ROWS },
    ),
    GOLDEN_COLS,
    GOLDEN_ROWS,
  );
  // fx stories: shade the field at exactly t = tick (seconds) so each
  // matrix cell photographs a distinct, reproducible phase.
  if (bufferHasBgFx(buf)) materializeBgFx(buf, state.tick);
  return buf;
}

async function main(): Promise<void> {
  const { host, port, states } = parseArgs();
  restoreTTY = silenceTTYEcho();
  // GLSL catalog in sync mode — the worker host races the first frame;
  // goldens must render at exactly t = tick.
  if (shadertoyGlAvailable()) {
    const r = await registerShadertoyCatalog({ worker: false });
    if (r.ids.length === 0) {
      console.error("story-demo: bgFx catalog empty — fx goldens stay flat");
    }
  } else {
    console.error("story-demo: headless-gl unavailable — fx goldens stay flat");
  }
  const byName = new Map(states.map((s) => [s.name, s]));

  const sock = createConnection({ host, port });
  await new Promise<void>((resolve, reject) => {
    sock.once("connect", () => resolve());
    sock.once("error", reject);
  });
  sock.setEncoding("utf8");
  const send = (o: unknown) => sock.write(`${JSON.stringify(o)}\n`);

  paint("\u001B[?1049h\u001B[2J\u001B[H\u001B[?25l");

  let prev: CellBuffer | null = null;

  const show = (state: GoldenState, force = false) => {
    const buf = renderState(state);
    paint(emitAnsi(prev, buf, { forceFull: force || !prev }));
    prev = cloneBuffer(buf);
  };

  // Initial frame: first matrix cell
  show(states[0]!, true);
  send({ type: "ready" });

  let carry = "";
  sock.on("data", (chunk: string) => {
    carry += chunk;
    const parts = carry.split("\n");
    carry = parts.pop() ?? "";
    for (const line of parts) {
      const t = line.trim();
      if (!t) continue;
      let msg: { type: string; name?: string };
      try {
        msg = JSON.parse(t) as { type: string; name?: string };
      } catch {
        continue;
      }
      if (msg.type === "quit") {
        paint("\u001B[?25h\u001B[?1049l");
        paintClose();
        restoreTTY();
        sock.end();
        process.exit(0);
      }
      if (msg.type === "step" && msg.name) {
        const name = msg.name;
        let state = byName.get(name);
        if (!state) {
          const parsed = parseGoldenSlug(name);
          if (parsed && getStory(parsed.storyId)) {
            state = {
              name,
              storyId: parsed.storyId,
              sample: parsed.sample,
              tick: parsed.tick,
              category: getStory(parsed.storyId)!.category,
            };
          }
        }
        if (!state) {
          send({ type: "error", message: `unknown step ${name}` });
          continue;
        }
        show(state);
        send({ type: "ready" });
      }
    }
  });

  sock.on("close", () => {
    paint("\u001B[?25h\u001B[?1049l");
    paintClose();
    restoreTTY();
    process.exit(0);
  });

  // Long timeout: full matrix × multi-term can run many minutes
  setTimeout(() => {
    paint("\u001B[?25h\u001B[?1049l");
    paintClose();
    restoreTTY();
    process.exit(1);
  }, 600_000).unref();
}

main().catch((error) => {
  console.error(error);
  paint("\u001B[?25h\u001B[?1049l");
  paintClose();
  restoreTTY();
  process.exit(1);
});
