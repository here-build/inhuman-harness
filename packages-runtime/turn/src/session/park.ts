/**
 * Pause interpretation. Open Calls stay. Abort reason `"park"` so Call /
 * program / turn handlers do not seal. On-wire MCP and live eval bags hold
 * the wrap until they settle; undispatched MCP is aborted without a receipt.
 */
import { evalProgramOf, MCPToolJob, McpToolExpectation, SessionRoot, SessionTurn } from "@inhuman.tools/harness-model";
import { Job, walkWork } from "@inhuman.tools/plexus-expectations";

import type { ParkWork } from "./types.js";

export function mcpJobOnWire(job: MCPToolJob): boolean {
  const pew = job.expectation;
  return (job.dispatched && !job.completed) || (pew.dispatched && !pew.isDone);
}

function mcpJobsOf(root: SessionRoot): MCPToolJob[] {
  const head = root.head;
  if (!(head instanceof SessionTurn)) return [];
  const jobs: MCPToolJob[] = [];
  for (const node of walkWork(head)) {
    if (node instanceof MCPToolJob) jobs.push(node);
  }
  return jobs;
}

function mcpCallsOf(root: SessionRoot): McpToolExpectation[] {
  const head = root.head;
  if (!(head instanceof SessionTurn)) return [];
  const calls: McpToolExpectation[] = [];
  for (const node of walkWork(head)) {
    if (node instanceof McpToolExpectation) calls.push(node);
  }
  return calls;
}

export function liveEvalWork(root: SessionRoot): Set<Job> {
  const held = new Set<Job>();
  for (const turn of root.liveTurns) {
    if (turn.evalSpec == null) continue;
    const program = evalProgramOf(turn);
    if (program == null || program.completed || program.cancelled) continue;
    held.add(program);
    for (const node of walkWork(program)) {
      if (node instanceof Job) held.add(node);
    }
  }
  return held;
}

export function dispatchedMcpSettled(root: SessionRoot): boolean {
  const jobs = mcpJobsOf(root).filter((job) => job.dispatched || job.expectation.dispatched);
  return jobs.every((job) => job.completed || job.cancelled);
}

export function abortParkableWork(
  root: SessionRoot,
  work: ParkWork,
): { readonly mcpPending: boolean; readonly evalPending: boolean } {
  const held = liveEvalWork(root);
  for (const job of work.inFlightJobs()) {
    if (job instanceof MCPToolJob && mcpJobOnWire(job)) continue;
    if (held.has(job)) continue;
    work.abortJob(job, "park");
  }
  for (const call of mcpCallsOf(root)) {
    if (call.isDone || call.dispatched) continue;
    work.abortExpectation?.(call, "park");
  }
  return {
    mcpPending: mcpJobsOf(root).some((job) => mcpJobOnWire(job)),
    evalPending: liveEvalWork(root).size > 0,
  };
}
