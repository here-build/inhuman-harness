import { useEffect, useState } from "react";
import { EvalTrace, type RegionGraph } from "@here.build/arrival-provenance";
import type { ProgrammaticJob } from "@inhuman.tools/harness-model";
import { replayScheme } from "@inhuman.tools/harness-scheme/replay";

import { useRegionGraph } from "./use-region-graph.js";
import { useDial } from "../client/context.js";

type Run = { readonly graph: RegionGraph | null; readonly done: boolean };

/**
 * A tracked program is rebuilt here from its children. A job from before tracks,
 * and the stories' fabricated runs, still read the daemon's feed.
 */
export function useWorkflowGraph(sessionId: string, program: ProgrammaticJob): Run {
  const dial = useDial();
  const [fed, setFed] = useState<Run>({ graph: null, done: false });
  const [trace, setTrace] = useState<EvalTrace | null>(null);
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (!program.trackMatch) {
      setTrace(null);
      const abort = new AbortController();
      setFed({ graph: null, done: false });
      dial.workflow(sessionId, program.uuid, (graph, done) => setFed({ graph, done }), abort.signal);
      return () => abort.abort();
    }
    const next = new EvalTrace();
    next.withAutoBindings();
    setTrace(next);
    setSettled(false);
    const abort = new AbortController();
    void replayScheme(program, next, abort.signal).then(
      () => {
        if (!abort.signal.aborted) setSettled(true);
        return undefined;
      },
      () => {
        if (!abort.signal.aborted) setSettled(true);
      },
    );
    return () => abort.abort();
  }, [dial, program, program.trackMatch, sessionId]);
  const rebuilt = useRegionGraph(trace);
  if (program.trackMatch) return { graph: rebuilt, done: settled };
  return fed;
}
