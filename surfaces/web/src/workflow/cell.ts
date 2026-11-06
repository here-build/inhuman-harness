import type { RegionGraph } from "@here.build/arrival-provenance";
import { type SessionOverview, type ToolCallJob, CallJob } from "@inhuman.tools/harness-model";
import { isWorkflowLeafMeta } from "@inhuman.tools/harness-model/session";

import { indexRegions } from "./region-nesting.js";
import { type AgentState, agentCell, agentFace } from "../shell/tape-read.js";
import { outcomeOf } from "../shell/tool-receipt.js";

/** A crossing's live face beside the trace: its state before the value lands, and a one-line status. */
export type WorkflowCell = {
  readonly state: AgentState;
  readonly status?: string;
  readonly value?: unknown;
};

/** What the graph reads cards from. A lookup, not a map: the source may compute on read, so a reader that observes tracks it. */
export type CellSource = { get(leafId: number): WorkflowCell | undefined };

const leafJobs = (graph: RegionGraph): Map<number, string> => {
  const ids = new Map<number, string>();
  for (const region of indexRegions(graph.roots).values()) {
    if (region.kind === "leaf" && isWorkflowLeafMeta(region.meta) && region.meta.jobId !== undefined) {
      ids.set(region.id, region.meta.jobId);
    }
  }
  return ids;
};

/**
 * Each leaf's card, read from the inner job it names. The job is the truth (the daemon's graph carries
 * no values), so a settling job changes its card without the graph being touched.
 */
export function jobCells(
  graph: RegionGraph,
  jobs: () => readonly ToolCallJob[],
  glanceOf: (sessionId: string) => SessionOverview | null,
): CellSource {
  const ids = leafJobs(graph);
  return {
    get(leafId) {
      const uuid = ids.get(leafId);
      const job = uuid === undefined ? undefined : jobs().find((candidate) => candidate.uuid === uuid);
      if (job === undefined) return undefined;
      const payload = job.observationPayload();
      const value = payload === "" ? {} : { value: payload };
      if (job instanceof CallJob) {
        const face = agentFace(agentCell(job), glanceOf(job.workerSessionId.trim()));
        return { state: face.state, ...(face.status === "" ? {} : { status: face.status }), ...value };
      }
      const outcome = outcomeOf(job.completed, job.outcomeSnap);
      return { state: outcome, ...value };
    },
  };
}
