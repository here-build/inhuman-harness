/**
 * Interactive terminal probes — I/O only.
 * Pure parse lives in parse.ts; env heuristics in env.ts.
 */

import type { Readable, Writable } from "node:stream";

import { guessColorDepth } from "./env.js";
import { extractOsc11FromBuffer, parseDecrqm2026, parseOsc11Payload, hasDa1Reply, stripProbeReplies } from "./parse.js";
import { OSC11_QUERY, PROBE_BATCH } from "./sequences.js";
import type { TerminalCaps } from "./types.js";

export type ProbeOpts = {
  stdin: Readable & { isTTY?: boolean };
  stdout: Writable & { isTTY?: boolean };
  timeoutMs?: number;
  /** Env for depth heuristics (default process.env) */
  env?: NodeJS.ProcessEnv;
  /**
   * When true (default), also send DECRQM 2026 + DA1 after OSC11.
   * Disable for minimal ground-only probe.
   */
  batch?: boolean;
};

export type DetectResult = {
  caps: TerminalCaps;
  /**
   * Stdin bytes accumulated during the probe that were not capability replies
   * (keystrokes / unrelated sequences). Re-inject into the app input path.
   * Empty when non-TTY or when the window only contained probe replies.
   */
  leftover: string;
};

/**
 * Detect terminal capabilities: env depth + optional OSC11 + DECRQM 2026.
 * Non-TTY → tty:false, env depth, no probes.
 */
export async function detectCapabilities(opts: ProbeOpts): Promise<DetectResult> {
  const env = opts.env ?? process.env;
  const depthGuess = guessColorDepth(env);
  const tty = !!(opts.stdin.isTTY && opts.stdout.isTTY);

  const base: TerminalCaps = {
    tty,
    colorDepth: depthGuess,
  };

  if (!tty) {
    return { caps: base, leftover: "" };
  }

  const timeoutMs = opts.timeoutMs ?? 100;
  const batch = opts.batch !== false;

  return new Promise((resolve) => {
    let buf = "";
    let settled = false;

    const finish = (caps: TerminalCaps) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.stdin.off("data", onData);
      // Replies stripped; residual = keystrokes during the probe window.
      resolve({ caps, leftover: stripProbeReplies(buf) });
    };

    const onData = (chunk: string | Buffer) => {
      buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const payload = extractOsc11FromBuffer(buf);
      const decrqm = parseDecrqm2026(buf);
      const da1 = hasDa1Reply(buf);

      // Batch ends with DA1 by design (PROBE_BATCH). Finish early only when
      // ground + DA1 are both in — never on DECRQM alone. Early-exit on 2026
      // left DA1 in the TTY queue; if it arrived after raw mode dropped at
      // exit, the shell painted `CSI ? 64;…c` (and friends) on the prompt.
      const haveGround = payload !== null;
      if (haveGround && (!batch || da1)) {
        const rgb = payload ? parseOsc11Payload(payload) : null;
        finish({
          ...base,
          groundRgb: rgb ?? undefined,
          sync2026: decrqm ?? undefined,
        });
      }
    };

    const timer = setTimeout(() => {
      const payload = extractOsc11FromBuffer(buf);
      const rgb = payload ? parseOsc11Payload(payload) : null;
      const decrqm = parseDecrqm2026(buf);
      finish({
        ...base,
        groundRgb: rgb ?? undefined,
        sync2026: decrqm ?? undefined,
      });
    }, timeoutMs);

    opts.stdin.on("data", onData);
    try {
      opts.stdout.write(batch ? PROBE_BATCH : OSC11_QUERY);
    } catch {
      finish(base);
    }
  });
}
