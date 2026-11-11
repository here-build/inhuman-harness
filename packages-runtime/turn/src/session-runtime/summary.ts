import {
  AskAgentSpec,
  latestUserPrompt,
  outgoingAgentRelations,
  SessionTurn,
  type AgentNature,
  type SessionUnfinished,
  type SessionPlexus,
  type SessionRoot,
} from "@inhuman.tools/harness-model/session";
import { comparer, reaction } from "mobx";

import { glanceAskLine } from "./ask-line.js";

export type SessionSummary = {
  readonly title: string;
  readonly recipeScope: AgentNature;
  readonly specName: string;
  readonly resident: boolean;
  readonly keepAlive: boolean;
  readonly oneShot: boolean;
  readonly model: string;
  readonly status: string;
  readonly midMotion: boolean;
  readonly openTurn: boolean;
  readonly openToolCount: number;
  readonly periodArmed: boolean;
  readonly openCallbackCount: number;
  readonly asking: boolean;
  readonly unfinished: SessionUnfinished;
  readonly lastPrompt: string;
  readonly askLine: string;
  readonly questionLine: string;
  readonly path: string;
  readonly calls: ReturnType<typeof outgoingAgentRelations>;
};

/**
 * The `sessions` columns that restate the document. `running` is `openTurn`.
 * The table's mode enum is older than the document: `act` is the agentic loop.
 */
export function sessionColumns(root: SessionRoot): {
  readonly title: string;
  readonly workspacePath: string;
  readonly mode: "assistant" | "agentic";
  readonly permissionMode: SessionRoot["standingPermissionMode"];
  readonly running: boolean;
  readonly headTurnId: string | null;
} {
  const mode = root.mode;
  return {
    title: root.title,
    workspacePath: root.path ?? "",
    mode: mode === "act" || mode === "agentic" ? "agentic" : "assistant",
    permissionMode: root.standingPermissionMode,
    running: root.openTurn,
    headTurnId: root.head?.uuid ?? null,
  };
}

export function sessionSummary(root: SessionRoot): SessionSummary {
  const spec = root.agent.spec;
  const unfinished = root.unfinished;
  return {
    title: root.title,
    recipeScope: spec.recipeScope,
    specName: spec.name,
    resident: spec.resident,
    keepAlive: spec.keepAlive,
    oneShot: spec instanceof AskAgentSpec,
    model: (root.kvs.model ?? "").trim(),
    status: root.turnDescription,
    midMotion: root.midMotion,
    openTurn: root.openTurn,
    openToolCount: root.openToolCount,
    periodArmed: root.periodArmed,
    openCallbackCount: root.openCallbackCount,
    asking: root.asking,
    unfinished,
    lastPrompt: latestUserPrompt(root.head),
    askLine: unfinished === "ask" ? glanceAskLine(root.head?.approvalHead ?? null) : "",
    questionLine: unfinished === "question" && root.head instanceof SessionTurn ? root.head.questionLine : "",
    path: root.path,
    calls: outgoingAgentRelations(root),
  };
}

export function observeSessionSummary(session: SessionPlexus, publish: (summary: SessionSummary) => void): () => void {
  return reaction(() => sessionSummary(session.root), publish, { equals: comparer.structural, fireImmediately: true });
}
