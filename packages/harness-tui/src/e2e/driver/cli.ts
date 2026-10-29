/**
 * Out-of-process terminal session driver.
 *
 * Spawned by vitest via execa with stdio fully piped — never inherits the
 * test runner's TTY, so scenario ANSI cannot corrupt vitest output.
 *
 * Protocol (JSON lines on stdout):
 *   → stdin:  { "op": "run", ...StartOpts }
 *   ← stdout: { "type": "ready" }
 *             { "type": "png", "name": "01-initial", "base64": "..." }
 *             { "type": "done" } | { "type": "error", "message": "..." }
 *
 * Or one-shot argv mode:
 *   node --import tsx src/e2e/driver/cli.ts --oneshot '<json>'
 */

import { startTerminalScenario } from "../session.js";
import type { TerminalId } from "../terminals-types.js";

type Oneshot = {
  terminal: TerminalId;
  command: string;
  cwd?: string;
  steps: Array<{ name: string; step?: string; settleMs?: number }>;
};

function emit(obj: unknown): void {
  // Only JSON to stdout — never ANSI
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

async function runOneshot(job: Oneshot): Promise<void> {
  const live = await startTerminalScenario({
    terminal: job.terminal,
    command: job.command,
    cwd: job.cwd,
  });
  try {
    emit({ type: "ready" });
    for (const s of job.steps) {
      if (s.step) await live.step(s.step);
      const png = await live.capture(s.settleMs);
      emit({
        type: "png",
        name: s.name,
        base64: png.toString("base64"),
      });
    }
    emit({ type: "done" });
  } finally {
    await live[Symbol.asyncDispose]();
  }
}

async function main(): Promise<void> {
  const oneshotIdx = process.argv.indexOf("--oneshot");
  if (oneshotIdx !== -1) {
    const raw = process.argv[oneshotIdx + 1];
    if (!raw) {
      emit({ type: "error", message: "missing --oneshot json" });
      process.exit(2);
    }
    const job = JSON.parse(raw) as Oneshot;
    try {
      await runOneshot(job);
      process.exit(0);
    } catch (error) {
      emit({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
      process.exit(1);
    }
  }

  // Interactive JSON-line mode (stdin)
  let carry = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    carry += chunk;
    const parts = carry.split("\n");
    carry = parts.pop() ?? "";
    for (const line of parts) {
      const t = line.trim();
      if (!t) continue;
      void (async () => {
        try {
          const msg = JSON.parse(t) as { op: string } & Oneshot;
          if (msg.op === "run") {
            await runOneshot(msg);
            process.exit(0);
          } else {
            emit({ type: "error", message: `unknown op ${msg.op}` });
            process.exit(2);
          }
        } catch (error) {
          emit({
            type: "error",
            message: error instanceof Error ? error.message : String(error),
          });
          process.exit(1);
        }
      })();
    }
  });
}

main().catch((error) => {
  emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
