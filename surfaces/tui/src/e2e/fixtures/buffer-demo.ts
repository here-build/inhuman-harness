/**
 * Scenario process: paint quickdraw buffer frames inside a real TTY.
 *
 * Usage (from the harness package root):
 *   node --import tsx src/e2e/fixtures/buffer-demo.ts --control 127.0.0.1:PORT
 *
 * Steps:
 *   (initial) full frame: panel + border + title + CJK
 *   dirty-row   — rewrite middle row only (emit dirty path)
 *   truecolor   — truecolor SGR bar
 *   wide-cjk    — wide glyph line stress
 */

import { createConnection } from "node:net";

import { cloneBuffer, createBuffer, emitAnsi, put, type Buffer as CellBuffer } from "@inhuman.tools/quickdraw/buffer";
import { quarantine } from "@inhuman.tools/quickdraw/lexicon";

import { paintClose, paintWrite, silenceTTYEcho } from "./paint-tty.js";

/**
 * Every literal color in this fixture is quarantine-2 (`test-vector`):
 * `emitAnsi` runs directly on these buffers with no `resolveStyle` pass in
 * between (no `quickdraw-theme` dependency here at all), so `role`/
 * `prominence` fields would never resolve to a concrete color — the cell
 * would paint as the terminal's bare default fg/bg, not the intended hue.
 * Migrating any of these to the semantic vocabulary would silently blank the
 * committed screenshot goldens (`__visual__/buffer-terminals.test.ts`,
 * `maxDiffRatio: 0.02` against every step, chrome included) rather than
 * produce a like-for-like recolor. Per plan (2026-07-30
 * quickdraw-color-hygiene.md, Phase 3): the Solarized truecolor strip and the
 * dirty-row marker are intentional test vectors either way; the incidental
 * chrome (frame/title/body/step) was a migration candidate but is quarantined
 * here too, for the reason above, rather than silently discolored.
 */

function parseControl(): { host: string; port: number } {
  // Refuse to run under vitest / bare node without our launch env — prevents
  // accidentally painting CSI into the test reporter's TTY.
  if (process.env["TERMINAL_E2E"] !== "1") {
    console.error("buffer-demo: set TERMINAL_E2E=1 (opened only via terminal-e2e drivers)");
    process.exit(2);
  }
  const i = process.argv.indexOf("--control");
  if (i === -1 || !process.argv[i + 1]) {
    console.error("usage: buffer-demo --control host:port");
    process.exit(2);
  }
  const raw = process.argv[i + 1]!;
  const [host, portStr] = raw.split(":");
  const port = Number(portStr);
  if (!host || !Number.isFinite(port)) {
    console.error("bad --control, expected host:port");
    process.exit(2);
  }
  return { host, port };
}

// frame/title/body/panel-fill/step literals below: test-vector quarantine
// (color-parity-ignore) — see file header; screenshot-pinned, no resolver
// runs in this fixture's render path.
function paintInitial(): CellBuffer {
  const buf = createBuffer(48, 12);
  // panel fill (transparent test: ground shows through unpainted; here we paint dim panel)
  for (let y = 0; y < buf.height; y++) {
    put(buf, 0, y, " ".repeat(buf.width), { bg: 235 });
  }
  put(buf, 1, 1, `┌${"─".repeat(44)}┐`, { fg: 240, bg: 235 });
  put(buf, 1, 2, "│", { fg: 240, bg: 235 });
  put(buf, 2, 2, " quickdraw-buffer terminal-e2e ", { fg: 81, bg: 235, bold: true });
  put(buf, 46, 2, "│", { fg: 240, bg: 235 });
  put(buf, 1, 3, "│", { fg: 240, bg: 235 });
  put(buf, 2, 3, " row damage · wide glyphs · truecolor ", { fg: 252, bg: 235 });
  put(buf, 46, 3, "│", { fg: 240, bg: 235 });
  put(buf, 1, 4, "│", { fg: 240, bg: 235 });
  put(buf, 2, 4, " middle: ........ waiting ........ ", { fg: 246, bg: 235 });
  put(buf, 46, 4, "│", { fg: 240, bg: 235 });
  put(buf, 1, 5, "│", { fg: 240, bg: 235 });
  put(buf, 2, 5, " CJK: 漢字かな ", { fg: 215, bg: 235 });
  put(buf, 46, 5, "│", { fg: 240, bg: 235 });
  put(buf, 1, 6, `└${"─".repeat(44)}┘`, { fg: 240, bg: 235 });
  put(buf, 1, 8, "step: initial", { fg: 244 });
  return buf;
}

// dirty-row marker (bright fg:196 on bg:235): test-vector quarantine
// (color-parity-ignore) — deliberately loud so the partial-redraw path is
// visually unmistakable in the golden; see file header.
function applyDirtyRow(prev: CellBuffer): CellBuffer {
  const next = cloneBuffer(prev);
  put(next, 2, 4, " middle: *** DIRTY UPDATE ***     ", {
    fg: 196,
    bg: 235,
    bold: true,
  });
  put(next, 1, 8, "step: dirty-row ", { fg: 244 });
  return next;
}

function applyTruecolor(prev: CellBuffer): CellBuffer {
  const next = cloneBuffer(prev);
  // Solarized rainbow strip: test-vector quarantine (color-parity-ignore) —
  // chosen for truecolor screenshot diffing (plan Phase 3); see file header.
  const colors = [
    quarantine({ r: 220, g: 50, b: 47 }, "test-vector"),
    quarantine({ r: 203, g: 75, b: 22 }, "test-vector"),
    quarantine({ r: 181, g: 137, b: 0 }, "test-vector"),
    quarantine({ r: 133, g: 153, b: 0 }, "test-vector"),
    quarantine({ r: 42, g: 161, b: 152 }, "test-vector"),
    quarantine({ r: 38, g: 139, b: 210 }, "test-vector"),
    quarantine({ r: 108, g: 113, b: 196 }, "test-vector"),
    quarantine({ r: 211, g: 54, b: 130 }, "test-vector"),
  ];
  let x = 2;
  for (const rgb of colors) {
    put(next, x, 9, "████", { fgRgb: rgb });
    x += 4;
  }
  put(next, 1, 8, "step: truecolor ", { fg: 244 });
  return next;
}

// wide-glyph line + step label: test-vector quarantine (color-parity-ignore)
// — see file header.
function applyWide(prev: CellBuffer): CellBuffer {
  const next = cloneBuffer(prev);
  put(next, 2, 10, "寬度測試 日本語 한글 🎉 ", { fg: 81, bg: 235 });
  put(next, 1, 8, "step: wide-cjk  ", { fg: 244 });
  return next;
}

let restoreTTY = (): void => {};

function teardownPaint(): void {
  try {
    paintWrite("\u001B[?25h\u001B[?1049l");
  } catch {
    /* ignore */
  }
  paintClose();
  restoreTTY();
}

async function main(): Promise<void> {
  const { host, port } = parseControl();
  const sock = createConnection({ host, port });
  await new Promise<void>((resolve, reject) => {
    sock.once("connect", () => resolve());
    sock.once("error", reject);
  });
  sock.setEncoding("utf8");

  const send = (obj: unknown) => sock.write(`${JSON.stringify(obj)}\n`);

  restoreTTY = silenceTTYEcho();
  // Enter alt-screen + hide cursor — only on /dev/tty, never redirected stdout
  paintWrite("\u001B[?1049h\u001B[2J\u001B[H\u001B[?25l");

  let prev: CellBuffer | null = null;
  let curr = paintInitial();
  paintWrite(emitAnsi(prev, curr, { forceFull: true }));
  prev = cloneBuffer(curr);
  send({ type: "ready" });

  let carry = "";
  const onLine = async (line: string) => {
    let msg: { type: string; name?: string };
    try {
      msg = JSON.parse(line) as { type: string; name?: string };
    } catch {
      return;
    }
    if (msg.type === "quit") {
      teardownPaint();
      sock.end();
      process.exit(0);
    }
    if (msg.type === "step" && msg.name) {
      try {
        switch (msg.name) {
          case "dirty-row": {
            curr = applyDirtyRow(curr);
            break;
          }
          case "truecolor": {
            curr = applyTruecolor(curr);
            break;
          }
          case "wide-cjk": {
            curr = applyWide(curr);
            break;
          }
          default: {
            send({ type: "error", message: `unknown step ${msg.name}` });
            return;
          }
        }
        paintWrite(emitAnsi(prev, curr));
        prev = cloneBuffer(curr);
        send({ type: "ready" });
      } catch (error) {
        send({
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  sock.on("data", (chunk: string) => {
    carry += chunk;
    const parts = carry.split("\n");
    carry = parts.pop() ?? "";
    for (const line of parts) {
      const t = line.trim();
      if (t) void onLine(t);
    }
  });

  sock.on("close", () => {
    teardownPaint();
    process.exit(0);
  });

  setTimeout(() => {
    teardownPaint();
    process.exit(1);
  }, 120_000).unref();
}

main().catch((error) => {
  console.error(error);
  teardownPaint();
  process.exit(1);
});
