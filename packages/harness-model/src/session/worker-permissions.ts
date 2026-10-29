/**
 * Remainder-PDP inputs follow the caller desk. Floor stays on the worker.
 * One-shot and session-scope delegate; project/global are policy roots.
 */
import type { AgentNature } from "../recipe-scope.js";
import { AskAgentSpec } from "./Agent.js";
import type { PermissionMode } from "./eval-context.js";
import type { McpPersistScope } from "./mcp-name-floor.js";
import type { SessionRoot } from "./SessionRoot.js";

export type DeskPermissionSnap = {
  readonly policy: PermissionMode;
  /** The caller's session read roots. */
  readonly roots: Record<string, string>;
  /** The caller's session grants (JSON `GrantRow[]`): a child inherits them. */
  readonly grantsJson: string;
  /** The caller's authorization overlay: a child is never looser than its caller. */
  readonly overlayJson: string;
  readonly tools: Record<string, McpPersistScope>;
  readonly blocked: Record<string, McpPersistScope>;
};

export type PermissionDeskKernel = {
  readonly agentCalls: Record<
    string,
    { readonly workerSessionId: string; readonly callerSessionId: string } | undefined
  >;
};

/** One-shot (`AskAgentSpec`) or session-scope. Project/global stay roots. */
export function delegatesPermissionMode(root: SessionRoot): boolean {
  const spec = root.agent.spec;
  const scope: AgentNature = spec.recipeScope;
  if (scope === "project" || scope === "global") return false;
  if (spec instanceof AskAgentSpec) return true;
  return scope === "session";
}

/** First live caller: open callbacks, else kernel relation. */
export function permissionDeskSessionId(worker: SessionRoot, kernel: PermissionDeskKernel): string {
  for (const id of Object.values(worker.agentCallbacks)) {
    const caller = typeof id === "string" ? id.trim() : "";
    if (caller !== "") return caller;
  }
  const workerId = worker.sessionId;
  for (const row of Object.values(kernel.agentCalls)) {
    if (row == null || row.workerSessionId !== workerId) continue;
    const caller = row.callerSessionId.trim();
    if (caller !== "") return caller;
  }
  return "";
}

export function deskPermissionSnap(desk: SessionRoot): DeskPermissionSnap {
  return {
    policy: desk.permissionMode,
    roots: { ...desk.readRoots },
    grantsJson: desk.grantsJson,
    overlayJson: desk.authorizationOverlayJson,
    tools: { ...desk.toolAllowlist },
    blocked: { ...desk.toolBlocklist },
  };
}

/** Live overlay: mode, roots, session grants and overlay follow the caller. The kernel layers stay the worker's own. */
export function projectWorkerPermissions(worker: SessionRoot, desk: SessionRoot): void {
  if (worker === desk) return;
  worker.applyPermissionSnap(deskPermissionSnap(desk));
}
