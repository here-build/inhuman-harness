import { CONTEXT_NEED_TOOL_NAME } from "@inhuman.tools/activity";

import { AgentCallJob } from "./jobs/AgentCallJob.js";
import { ContextNeedToolJob } from "./jobs/ContextNeedToolJob.js";
import { ProgrammaticJob } from "./jobs/ProgrammaticJob.js";
import { ToolCallJob } from "./jobs/ToolCallJob.js";

/** Caller-facing identity and description; never the worker's full brief. */
export function spawnDescriptionArgs(job: AgentCallJob): Record<string, string> {
  const args = job.args ?? {};
  return {
    description: job.description,
    ...(typeof args.spec === "string" ? { spec: args.spec } : {}),
    ...(job.faceName === "" ? {} : { faceName: job.faceName }),
    ...(job.workerSessionId === "" ? {} : { workerSessionId: job.workerSessionId }),
  };
}

/** Only executed spawn jobs establish that an enclosing program contains a brief.
 * Do not rewrite Scheme literals: the brief can be assembled from variables or modules. */
export function spawnProgramTools(program: ProgrammaticJob | ToolCallJob): ToolCallJob[] {
  const tools: ToolCallJob[] = [];
  const seen = new Set<ProgrammaticJob | ToolCallJob>();
  const containsSpawn = (node: ProgrammaticJob | ToolCallJob, checking = new Set<unknown>()): boolean => {
    if (node instanceof AgentCallJob) return true;
    if (checking.has(node)) return false;
    checking.add(node);
    return node.children.some(
      (child) => (child instanceof ProgrammaticJob || child instanceof ToolCallJob) && containsSpawn(child, checking),
    );
  };
  const visit = (node: ProgrammaticJob | ToolCallJob): void => {
    if (seen.has(node)) return;
    seen.add(node);
    if (node instanceof AgentCallJob) {
      tools.push(node);
      return;
    }
    if (node instanceof ContextNeedToolJob || (node instanceof ToolCallJob && node.name === CONTEXT_NEED_TOOL_NAME))
      return;
    const children = node.children.filter(
      (child): child is ProgrammaticJob | ToolCallJob =>
        child instanceof ProgrammaticJob || child instanceof ToolCallJob,
    );
    if (node instanceof ToolCallJob && !containsSpawn(node)) {
      tools.push(node);
      return;
    }
    for (const child of children) visit(child);
  };
  for (const child of program.children) {
    if (child instanceof ProgrammaticJob || child instanceof ToolCallJob) visit(child);
  }
  return tools;
}

/** Model-facing program label. Stored Scheme source stays available for inspection. */
export function spawnProgramDescription(program: ProgrammaticJob | ToolCallJob): string | null {
  const tools = spawnProgramTools(program);
  if (!tools.some((job) => job instanceof AgentCallJob)) return null;
  return tools
    .map((job) => (job instanceof AgentCallJob ? `${job.name} ${JSON.stringify(spawnDescriptionArgs(job))}` : job.name))
    .join("; ");
}
