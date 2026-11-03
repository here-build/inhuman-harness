import { AgentCallJob } from "./jobs/AgentCallJob.js";
import { BotCallJob } from "./jobs/BotCallJob.js";
import { CallJob } from "./jobs/CallJob.js";
import type { SessionRoot } from "./SessionRoot.js";
import type { AgentRelationSnap } from "../shared/agent-relation.js";

export type { AgentRelationSnap } from "../shared/agent-relation.js";

export function outgoingAgentRelations(root: SessionRoot): AgentRelationSnap[] {
  const out: AgentRelationSnap[] = [];
  const seen = new Set<CallJob>();
  for (const node of root.motionWork()) {
    if (!(node instanceof CallJob) || seen.has(node)) continue;
    seen.add(node);
    const workerSessionId = node.workerSessionId.trim();
    const id = node.uuid.trim();
    if (workerSessionId === "" || id === "") continue;
    const specFromArgs = node.args?.spec;
    const spec =
      (typeof specFromArgs === "string" ? specFromArgs.trim() : "") ||
      (node instanceof BotCallJob ? (node.botName ?? "").trim() || (node.contributionBotName ?? "").trim() : "");
    out.push({
      id,
      workerSessionId,
      spec,
      oneShot: node instanceof AgentCallJob,
      completed: node.completed,
    });
  }
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}
