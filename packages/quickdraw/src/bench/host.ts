/**
 * TEA host pieces for the fps experiment — the retired first-generation host,
 * kept bench-local. The product protocol is box-bus (`quickdraw-runtime`);
 * this whole-model snapshot channel exists only to drive the load box.
 */
import type { Generation, Snapshot } from "./tea.js";

/** Main → Worker */
export type HostToWorker =
  | { type: "init"; cols: number; rows: number }
  | { type: "resize"; cols: number; rows: number }
  | { type: "key"; key: string }
  | { type: "tick"; now: number };

/** Worker → Main */
export type WorkerToHost<Model> = { type: "snapshot"; snap: Snapshot<Model> };

/**
 * Latest-wins box: render always takes the freshest snapshot.
 * Intermediate models are dropped (backpressure).
 *
 * **Thread-safety invariant:** single host event loop only. Safe when the
 * worker `message` handler and the present `onFrame` callback both run on the
 * same Node/main event loop (never concurrent). No Atomics — do not share one
 * mailbox across workers/OS threads or move paint off that loop without a
 * redesign.
 */
export class LatestMailbox<Model> {
  private snap: Snapshot<Model> | null = null;
  private dropped = 0;

  /** One call may carry a burst. The newest gen wins; older gens in the burst count as dropped. */
  push(...snaps: Snapshot<Model>[]): void {
    for (const snap of snaps) {
      if (this.snap !== null && snap.gen < this.snap.gen) continue;
      if (this.snap !== null) this.dropped += 1;
      this.snap = snap;
    }
  }

  /** Read without clearing (render may re-read same gen if no update). */
  peek(): Snapshot<Model> | null {
    return this.snap;
  }

  takeDropped(): number {
    const d = this.dropped;
    this.dropped = 0;
    return d;
  }
}

export type FpsStats = {
  fps: number;
  frameMs: number;
  presents: number;
  skippedEmpty: number;
  snapshotsDropped: number;
  lastGen: Generation;
};

export function createFpsTracker(): {
  recordPresent: (frameMs: number) => void;
  recordSkip: () => void;
  addDropped: (n: number) => void;
  setGen: (g: Generation) => void;
  sample: () => FpsStats;
} {
  let windowStart = performance.now();
  let presents = 0;
  let skipped = 0;
  let dropped = 0;
  let lastFrameMs = 0;
  let lastGen: Generation = 0;
  let fps = 0;
  /** Count in the current 1s window for live fps. */
  let windowPresents = 0;

  return {
    recordPresent(frameMs) {
      presents += 1;
      windowPresents += 1;
      lastFrameMs = frameMs;
      const now = performance.now();
      if (now - windowStart >= 1000) {
        fps = windowPresents / ((now - windowStart) / 1000);
        windowPresents = 0;
        windowStart = now;
      }
    },
    recordSkip() {
      skipped += 1;
    },
    addDropped(n) {
      dropped += n;
    },
    setGen(g) {
      lastGen = g;
    },
    sample(): FpsStats {
      return {
        fps,
        frameMs: lastFrameMs,
        presents,
        skippedEmpty: skipped,
        snapshotsDropped: dropped,
        lastGen,
      };
    },
  };
}
