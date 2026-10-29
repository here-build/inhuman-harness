function traceLoopLag(dt: number, interval: number): void {
  const raw = process.env.DEBUG;
  if (raw === undefined || raw.trim() === "") return;
  const names = raw.split(/[\s,]+/).filter((part) => part !== "");
  const enabled = names.some((part) => {
    const name = part.startsWith("-") ? "" : part;
    return name === "*" || name === "quickdraw:loop" || name === "quickdraw:*" || name.startsWith("quickdraw:");
  });
  if (!enabled) return;
  process.stderr.write(
    `${new Date().toISOString()} quickdraw:loop pid=${process.pid} lagMs=${Math.round(dt)} intervalMs=${Math.round(interval)}\n`,
  );
}

/**
 * Fixed-rate present loop. Calls onFrame at targetFps.
 * Does not own any mailbox — the caller peeks its own state.
 */
export function startPresentLoop(opts: { targetFps: number; onFrame: (dtMs: number) => void }): { stop: () => void } {
  const interval = 1000 / opts.targetFps;
  let last = performance.now();
  let timer: ReturnType<typeof setInterval> | null = null;

  timer = setInterval(() => {
    const now = performance.now();
    const dt = now - last;
    last = now;
    // M7: a thrown paint must not escape the interval callback — that kills the
    // process (uncaughtException) before alt-screen teardown can run. Log and
    // keep the loop alive so the host can tear down via stop().
    try {
      opts.onFrame(dt);
    } catch (error) {
      console.error("[quickdraw-runtime] onFrame threw:", error);
    }
    if (dt > interval * 1.5) traceLoopLag(dt, interval);
  }, interval);

  return {
    stop: () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
  };
}
