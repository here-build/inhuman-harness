/**
 * UI-thread face: probe + attune + TTY enter + Renderer.
 * Teardown is split — do not collapse into one stop().
 */
import type { Readable, Writable } from "node:stream";

import { detectCapabilities } from "./capabilities/index.js";
import { attuneTheme, setActiveTheme, setColorDepth, type ThemeBinding } from "./layout/paint_theme.js";
import type { PaintLocal, RetainedPaintSource } from "./runtime/paint_source.js";
import { resolvePresentConfig, type PresentConfig } from "./runtime/present_profile.js";
import { Renderer, type BoxCadencePort, type TtyInput, type TtyOutput } from "./runtime/renderer.js";
import { holdStderr } from "./runtime/stderr_hold.js";
import { createTtySession, type TtyOptions, type TtySession } from "./runtime/tty.js";
import { canvasPolarity } from "./theme/ansi16.js";
import { bootSyntax } from "./widgets/syntax-boot.js";

/** OSC 11 wait — too short only means default ground (wrong one direction). */
export const GROUND_PROBE_TIMEOUT_MS = 80;

/** Post-probe / pre-exit stdin drain — late DA1/OSC11 must not reach the shell. */
export const STDIN_DRAIN_MS = 50;

export type AttuneStdin = Readable & {
  readonly isTTY?: boolean;
  setRawMode?(mode: boolean): void;
};

export type AttuneStdout = Writable & {
  readonly isTTY?: boolean;
};

/** process.stderr / test stream — held while alt-screen occupies the glass. */
export type AttuneStderr = Writable & {
  readonly isTTY?: boolean;
};

/** process.stdout / test stream — columns + resize for the cadence output face. */
export type StdioStdout = AttuneStdout & {
  columns?: number;
  rows?: number;
  on?(event: "resize", listener: () => void): unknown;
};

/** stdin → {@link TtyInput}. Same adapter the harness host uses. */
export function processStdioInput(stdin: AttuneStdin): TtyInput {
  return {
    onData(handler) {
      if (typeof stdin.setEncoding === "function") stdin.setEncoding("utf8");
      stdin.resume();
      stdin.on("data", (chunk: string) => handler(chunk));
    },
    setRawMode(enabled) {
      if (stdin.isTTY) stdin.setRawMode?.(enabled);
    },
  };
}

/** stdout → {@link TtyOutput}. */
export function processStdioOutput(stdout: StdioStdout): TtyOutput {
  return {
    write(text) {
      stdout.write(text);
    },
    get cols() {
      return stdout.columns ?? 80;
    },
    get rows() {
      return stdout.rows ?? 24;
    },
    onResize(handler) {
      stdout.on?.("resize", handler);
    },
  };
}

export interface StartRenderOptions {
  readonly stdin: AttuneStdin;
  readonly stdout: AttuneStdout;
  /** Held during alt-screen when both this and stdout are TTYs. Default process.stderr. */
  readonly stderr?: AttuneStderr;
  readonly port: BoxCadencePort;
  readonly input: TtyInput;
  readonly output: TtyOutput;
  readonly targetFps?: number;
  readonly onQuit?: () => void;
  /** Armed Ctrl-C hint. Default `"exit"`. */
  readonly quitAction?: () => string;
  readonly onReady?: () => void;
  readonly onFirstPaint?: () => void;
  readonly composerBoxKey?: string;
  readonly composerFrameKey?: string;
  readonly paintSource?: RetainedPaintSource;
  readonly paintLocal?: PaintLocal;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly tty?: TtyOptions;
}

export interface RenderHandle {
  stop(): void;
  restore(): void;
}

export interface AttunedBoot {
  readonly binding: ThemeBinding;
  readonly present: PresentConfig;
}

/**
 * Read-and-discard stdin briefly. Call while still owning the TTY (ideally raw)
 * so late capability replies never land as shell-prompt garbage.
 */
export function drainStdinQuiet(stdin: AttuneStdin, ms: number = STDIN_DRAIN_MS): Promise<void> {
  if (!stdin.isTTY) return Promise.resolve();
  return new Promise((resolve) => {
    const onData = (): void => {
      /* discard */
    };
    stdin.resume();
    stdin.on("data", onData);
    setTimeout(() => {
      stdin.off("data", onData);
      resolve();
    }, ms);
  });
}

async function probeAndAttune(
  stdin: AttuneStdin,
  stdout: AttuneStdout,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<AttunedBoot> {
  const setRawMode =
    typeof stdin.isTTY === "boolean" && stdin.isTTY && typeof stdin.setRawMode === "function"
      ? stdin.setRawMode.bind(stdin)
      : null;
  if (setRawMode) {
    try {
      setRawMode(true);
    } catch {
      /* non-fatal: probe still runs; echo risk remains */
    }
  }

  let binding: ThemeBinding;
  let present: PresentConfig;
  try {
    try {
      const { caps } = await detectCapabilities({
        stdin,
        stdout,
        env,
        timeoutMs,
        batch: true,
      });
      present = resolvePresentConfig({
        env,
        probedDepth: caps.colorDepth,
        probedSync2026: caps.sync2026,
      });
      const rgb = caps.groundRgb;
      binding = attuneTheme({
        depth: present.colorDepth,
        groundRgb: rgb,
      });
    } catch {
      present = resolvePresentConfig({ env });
      binding = attuneTheme({ depth: present.colorDepth });
    }
    await drainStdinQuiet(stdin, STDIN_DRAIN_MS);
  } finally {
    if (setRawMode) {
      try {
        setRawMode(false);
      } catch {
        /* best-effort */
      }
    }
  }

  setActiveTheme(binding.theme);
  setColorDepth(binding.depth);
  return { binding, present };
}

export async function startRender(opts: StartRenderOptions): Promise<RenderHandle> {
  const env = opts.env ?? process.env;
  const { binding, present } = await probeAndAttune(
    opts.stdin,
    opts.stdout,
    env,
    opts.timeoutMs ?? GROUND_PROBE_TIMEOUT_MS,
  );
  // Same law as `fx`: per-frame 2026 unless QD_SYNC=0. Probe does not
  // turn the bracket off — that is what made storybook look vsync-off.
  const sync2026 = opts.tty?.sync2026 ?? env.QD_SYNC !== "0";
  const tty: TtySession = createTtySession(
    opts.tty ?? {
      sync2026,
    },
  );
  const stderr = opts.stderr ?? process.stderr;
  const hold = opts.stdout.isTTY === true && stderr.isTTY === true ? holdStderr(stderr) : null;
  opts.stdout.write(tty.enterBytes());
  tty.markEntered();

  const host = new Renderer({
    port: opts.port,
    input: opts.input,
    output: opts.output,
    theme: binding,
    targetFps: opts.targetFps ?? present.targetFps,
    flourishHz: present.flourishHz,
    sync2026,
    onQuit: opts.onQuit,
    quitAction: opts.quitAction,
    onReady: opts.onReady,
    onFirstPaint: opts.onFirstPaint,
    composerBoxKey: opts.composerBoxKey,
    composerFrameKey: opts.composerFrameKey,
    paintSource: opts.paintSource,
    paintLocal: opts.paintLocal,
  });
  host.start();
  void bootSyntax(canvasPolarity(binding.theme.ground)).then(() => host.requestPaint());

  return {
    stop() {
      host.stop();
    },
    restore() {
      if (tty.entered) {
        opts.stdout.write(tty.exitBytes());
        tty.markExited();
      }
      // After leave-alt — held bytes must land on the primary screen.
      hold?.release();
    },
  };
}
