import {
  AgentCallJob,
  ContextNeedToolJob,
  ProgrammaticJob,
  spawnDescriptionArgs,
  spawnProgramTools,
  ToolCallJob,
} from "@inhuman.tools/harness-model";

import { BACKGROUND_TOOL, IN_FLIGHT_TOOL } from "./observations.js";
import { refOfNode } from "./retention/render.js";
import { squeezeObservation, squeezeProgrammaticText, squeezeToolCall } from "./squeeze.js";

export const OMITTED_PROGRAM = { description: "Delegated work; enclosing program source omitted." };

/** A spawn-bearing invocation's executed operations, including intermediate receipts.
 * Every program inside this envelope loses its source, even a sibling that did
 * not itself spawn: variables and modules can carry the same worker brief. */
export function spawnProgramOperations(
  root: ToolCallJob | ProgrammaticJob,
): Array<ToolCallJob | ProgrammaticJob> | null {
  if (!spawnProgramTools(root).some((job) => job instanceof AgentCallJob)) return null;
  const operations: Array<ToolCallJob | ProgrammaticJob> = [];
  const seen = new Set<ToolCallJob | ProgrammaticJob>([root]);
  const visit = (job: ToolCallJob | ProgrammaticJob): void => {
    if (seen.has(job) || job instanceof ContextNeedToolJob) return;
    seen.add(job);
    operations.push(job);
    if (job instanceof AgentCallJob) return;
    for (const child of job.children) {
      if (child instanceof ToolCallJob || child instanceof ProgrammaticJob) visit(child);
    }
  };
  for (const child of root.children) {
    if (child instanceof ToolCallJob || child instanceof ProgrammaticJob) visit(child);
  }
  return operations;
}

/** Tool wrappers also carry source on their args; their child receipts survive separately. */
export function isProgramEnvelope(job: ToolCallJob | ProgrammaticJob): boolean {
  if (job instanceof AgentCallJob) return false;
  return (
    job instanceof ProgrammaticJob ||
    job.children.some((child) => child instanceof ProgrammaticJob || child instanceof ToolCallJob)
  );
}

/** Compaction sees the same source-free identities as history, plus bounded receipts. */
export function spawnHistoryText(root: ToolCallJob | ProgrammaticJob): string | null {
  const operations = root instanceof AgentCallJob ? [] : spawnProgramOperations(root);
  if (operations === null) return null;
  const rows = [root, ...operations].map((job) => {
    const name = job instanceof ToolCallJob ? job.name : job.toolName;
    const args =
      job instanceof AgentCallJob ? spawnDescriptionArgs(job) : isProgramEnvelope(job) ? OMITTED_PROGRAM : job.args;
    const ref = refOfNode(job);
    const argText = squeezeObservation({
      to: "compact",
      payload: args,
      persistable: true,
      ...(ref === undefined ? {} : { recallRef: `${ref}#args` }),
      name,
    });
    const programText = job instanceof ProgrammaticJob ? job.resultText() : "";
    const result = !job.completed
      ? job.background
        ? BACKGROUND_TOOL
        : IN_FLIGHT_TOOL
      : job instanceof ToolCallJob
        ? squeezeToolCall(job, "compact")
        : squeezeProgrammaticText(job, programText === "" ? (job.receiptJson ?? "") : programText);
    return { label: `[${name} ${job.toolCallId}]`, args: argText, result, agent: job instanceof AgentCallJob };
  });
  // Preserve worker identities before a large mixed-operation receipt reaches
  // the normal compact cap. Results stay paired by their original call IDs.
  const identities = [...rows.filter((row) => row.agent), ...rows.filter((row) => !row.agent)]
    .map((row) => `${row.label}\n${row.args}`)
    .join("\n\n");
  const receipts = rows.map((row) => `${row.label}\n${row.result}`).join("\n\n");
  const ref = refOfNode(root);
  return squeezeObservation({
    to: "compact",
    payload: `${identities}\n\n${receipts}`,
    persistable: true,
    ...(ref === undefined ? {} : { recallRef: ref }),
    name: root instanceof ToolCallJob ? root.name : root.toolName,
  });
}
