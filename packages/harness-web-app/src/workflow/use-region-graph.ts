import { useEffect, useState } from "react";
import { type EvalTrace, type RegionGraph, TraceRegionFold } from "@here.build/arrival-provenance";
import { reaction } from "mobx";

/**
 * The live RegionGraph of an `EvalTrace`, kept current by an INCREMENTAL FOLD
 * (`TraceRegionFold`) — a stateful twin of `traceToRegions` that ingests only the NEW
 * invocations each tick (O(Δ)) instead of rebuilding from scratch (O(N)). It lives OUTSIDE
 * the reactive render: a mobx `reaction` watches only the cheap `trace.entries` counter
 * (ticks once per invocation) and schedules a rebuild.
 *
 * The ADAPTIVE THROTTLE: each rebuild times itself and schedules the next no sooner than its
 * own cost, so the cadence collapses toward one frame while Δ is small. The reaction fires
 * on every tick, so the trailing edge always lands the final graph once the run settles.
 * Region `id`s are stable across ticks, so per-id view state (tabs, collapse) survives.
 *
 * Returns `null` until the first build lands (or `trace` is null).
 */
export function useRegionGraph(trace: EvalTrace | null): RegionGraph | null {
  const [graph, setGraph] = useState<RegionGraph | null>(null);
  useEffect(() => {
    if (!trace) {
      setGraph(null);
      return;
    }
    const fold = new TraceRegionFold(trace);
    let timer = 0;
    let lastBuildMs = 0;
    let disposed = false;
    const rebuild = (): void => {
      timer = 0; // cleared first so ticks arriving DURING the build reschedule
      const t0 = performance.now();
      fold.applyDelta();
      const g = fold.current();
      lastBuildMs = performance.now() - t0;
      if (!disposed) setGraph(g);
    };
    const schedule = (): void => {
      if (timer !== 0) return; // a build is already pending; it'll read the latest
      const delay = Math.min(2000, Math.max(16, Math.round(lastBuildMs)));
      timer = window.setTimeout(rebuild, delay);
    };
    const dispose = reaction(() => trace.entries, schedule, { fireImmediately: true });
    return () => {
      disposed = true;
      dispose();
      if (timer !== 0) clearTimeout(timer);
    };
  }, [trace]);
  return graph;
}
