/**
 * Live terminal scenario session — vitest-friendly lifecycle.
 *
 *   const s = await startTerminalScenario({ terminal, command, cwd });
 *   await expect(await s.capture()).toMatchTerminalGolden({ … });
 *   await s.step("dirty-row");
 *   await expect(await s.capture()).toMatchTerminalGolden({ … });
 *   await s[Symbol.asyncDispose]();
 */

import { createControlHost, type ControlHost } from "./control.js";
import { captureFrontWindow } from "./screenshot.js";
import { type TerminalId } from "./terminals-types.js";
import { captureProcessNames, metaFor, openTerminal, type TerminalSession } from "./terminals.js";

export type StartTerminalScenarioOpts = {
  terminal: TerminalId;
  /** Use `{{control}}` for host:port. */
  command: string;
  cwd?: string;
  /** Default settle before capture (ms). */
  settleMs?: number;
};

export type LiveTerminalScenario = {
  readonly terminal: TerminalId;
  readonly processName: string;
  /** Send a step and wait for the next ready. */
  step: (name: string, timeoutMs?: number) => Promise<void>;
  /** Screenshot the scenario window (after optional settle). */
  capture: (settleMs?: number) => Promise<Buffer>;
  /** Quit scenario + close terminal window. */
  [Symbol.asyncDispose](): Promise<void>;
};

export async function startTerminalScenario(opts: StartTerminalScenarioOpts): Promise<LiveTerminalScenario> {
  const meta = metaFor(opts.terminal);
  const control: ControlHost = await createControlHost();
  const controlAddr = `${control.host}:${control.port}`;
  const command = opts.command.replaceAll("{{control}}", controlAddr);
  const defaultSettle = opts.settleMs ?? 500;

  let session: TerminalSession | null = null;
  let closed = false;

  // Cold launch of Ghostty/kitty after another terminal can exceed 45s.
  const firstReady = control.waitReady(90_000);
  session = await openTerminal(opts.terminal, {
    command,
    cwd: opts.cwd,
  });
  await firstReady;

  const procNames = captureProcessNames(meta);

  return {
    terminal: opts.terminal,
    processName: meta.processName,
    async step(name, timeoutMs = 45_000) {
      const nextReady = control.waitReady(timeoutMs);
      await control.send({ type: "step", name });
      await nextReady;
    },
    async capture(settleMs = defaultSettle) {
      return captureFrontWindow(meta.processName, {
        settleMs,
        processNames: procNames,
        retries: 10,
        retryDelayMs: 300,
      });
    },
    async [Symbol.asyncDispose]() {
      if (closed) return;
      closed = true;
      try {
        await control.send({ type: "quit" });
      } catch {
        /* ignore */
      }
      // Let the scenario act on `quit` and restore the screen on its own. It
      // was launched with `exec`, so its exit ends the window's process and
      // the terminal closes itself; this then only has to reap a
      // scenario that ignored the quit.
      await new Promise((resolve) => setTimeout(resolve, 500));
      await control[Symbol.asyncDispose]();
      if (session) await session[Symbol.asyncDispose]();
      session = null;
    },
  };
}
