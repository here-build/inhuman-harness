import type { RegionGraph } from "@here.build/arrival-provenance";
import { applyJsonPatch, type WorkflowFrame } from "@inhuman.tools/harness-model/session";

/** Where a feed stands: the run (gen), the last frame folded (seq), the graph so far. */
export type Feed = { readonly gen: number; readonly seq: number; readonly graph: RegionGraph; readonly done: boolean };

/**
 * One frame folded into the feed. A snapshot opens or replaces; a patch applies only to the run it
 * was cut against and only as the next one. Anything else is a gap, and the way across is to
 * reconnect: the server opens every connection with a snapshot.
 */
export function foldFrame(feed: Feed | null, frame: WorkflowFrame): Feed | "resync" {
  if (frame.kind === "snapshot") {
    return { gen: frame.gen, seq: frame.seq, graph: frame.graph as RegionGraph, done: frame.done };
  }
  if (feed?.gen !== frame.gen || frame.seq !== feed.seq + 1) return "resync";
  try {
    return {
      gen: feed.gen,
      seq: frame.seq,
      graph: applyJsonPatch(feed.graph, frame.ops) as RegionGraph,
      done: frame.done,
    };
  } catch {
    return "resync";
  }
}
