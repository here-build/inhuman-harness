/**
 * Pure TypeScript row & insert types for the canonical Harness tables.
 * Kept free of `drizzle-orm` imports so browser, SDK, and non-SQLite runtimes
 * (`@inhuman.tools/turn`, ElectricSQL, `skipLibCheck: false` consumers) depend
 * only on plain structural types; `sqlite.ts` verifies compile-time identity
 * against the Drizzle `sqliteTable` definitions.
 */

export type KernelStateRow = {
  id: string;
  kernelId: string;
  defaultModel: string;
  permissionMode: string;
  enabledPluginsJson: string;
  kvsJson: string;
  updatedAtMs: number;
};

export type KernelStateRowInsert = {
  id?: string;
  kernelId?: string;
  defaultModel?: string;
  permissionMode?: string;
  enabledPluginsJson?: string;
  kvsJson?: string;
  updatedAtMs: number;
};

export type KernelRow = KernelStateRow;

export type ProjectKind = "local" | "remote" | "virtual";

export type ProjectRow = {
  projectId: string;
  kernelId: string;
  title: string;
  kind: ProjectKind;
  workspacePath: string | null;
  defaultPermissionMode: string;
  authorizationJson: string;
  kvsJson: string;
  lastUsedModelJson: string;
  enabledPluginsJson: string;
  pluginConfigsJson: string;
  botsRosterJson: string;
  trusted: boolean;
  contentHash: string | null;
  revision: number;
  updatedAtMs: number;
};

export type ProjectRowInsert = {
  projectId: string;
  kernelId?: string;
  title?: string;
  kind?: ProjectKind;
  workspacePath?: string | null;
  defaultPermissionMode?: string;
  authorizationJson?: string;
  kvsJson?: string;
  lastUsedModelJson?: string;
  enabledPluginsJson?: string;
  pluginConfigsJson?: string;
  botsRosterJson?: string;
  trusted?: boolean;
  contentHash?: string | null;
  revision?: number;
  updatedAtMs: number;
};

export type ScopeNodeRow = {
  id: string;
  kernelId: string;
  scopeId: string;
  nodeId: string;
  tag: string;
  isRoot: boolean;
  revision: number;
  rowJson: string;
};

export type ScopeNodeRowInsert = {
  id: string;
  kernelId?: string;
  scopeId: string;
  nodeId: string;
  tag: string;
  isRoot?: boolean;
  revision: number;
  rowJson: string;
};

export type SessionRow = {
  sessionId: string;
  kernelId: string;
  projectId: string;
  title: string;
  workspacePath: string;
  mode: "assistant" | "agentic";
  permissionMode: string;
  running: boolean;
  headTurnId: string | null;
  parentSessionId: string | null;
  parentCallId: string | null;
  depth: number;
  revision: number;
  createdAtMs: number;
  lastActiveAtMs: number;
  archivedAtMs: number | null;
};

export type SessionRowInsert = {
  sessionId: string;
  kernelId?: string;
  projectId?: string;
  title?: string;
  workspacePath?: string;
  mode?: "assistant" | "agentic";
  permissionMode?: string;
  running?: boolean;
  headTurnId?: string | null;
  parentSessionId?: string | null;
  parentCallId?: string | null;
  depth?: number;
  revision?: number;
  createdAtMs: number;
  lastActiveAtMs: number;
  archivedAtMs?: number | null;
};

export type SessionSummaryRow = SessionRow;

export type PendingAskRow = {
  jobId: string;
  kernelId: string;
  sessionId: string;
  turnId: string;
  kind: "ask" | "ack";
  object: string;
  summary: string;
  createdAtMs: number;
  readonly id?: string;
};

export type PendingAskRowInsert = {
  jobId: string;
  kernelId?: string;
  sessionId: string;
  turnId: string;
  kind: "ask" | "ack";
  object: string;
  summary: string;
  createdAtMs: number;
};

export type SessionTurnStatus = "running" | "completed" | "cancelled" | "failed" | "interrupted";

export type SessionTurnRow = {
  turnId: string;
  kernelId: string;
  sessionId: string;
  ordinal: number;
  prompt: string;
  status: SessionTurnStatus;
  cancelRequested: boolean;
  reducerExited: boolean;
  startedAtMs: number;
  endedAtMs: number | null;
};

export type SessionTurnRowInsert = {
  turnId: string;
  kernelId?: string;
  sessionId: string;
  ordinal: number;
  prompt: string;
  status: SessionTurnStatus;
  cancelRequested?: boolean;
  reducerExited?: boolean;
  startedAtMs: number;
  endedAtMs?: number | null;
};

export type SessionNodeRow = {
  id: string;
  kernelId: string;
  sessionId: string;
  nodeId: string;
  tag: string;
  isRoot: boolean;
  revision: number;
  rowJson: string;
};

export type SessionNodeRowInsert = {
  id: string;
  kernelId?: string;
  sessionId: string;
  nodeId: string;
  tag: string;
  isRoot?: boolean;
  revision: number;
  rowJson: string;
};

export type SessionEffectRow = {
  id: string;
  kernelId: string;
  sessionId: string;
  effectKey: string;
  kind: "commit" | "command" | "effect";
  phase: "intent" | "result" | "committed";
  inputHash: string;
  outcomeJson: string;
  revision: number;
  createdAtMs: number;
};

export type SessionEffectRowInsert = {
  id: string;
  kernelId?: string;
  sessionId: string;
  effectKey: string;
  kind: "commit" | "command" | "effect";
  phase?: "intent" | "result" | "committed";
  inputHash: string;
  outcomeJson: string;
  revision: number;
  createdAtMs: number;
};

export type SessionBlobRow = {
  id: string;
  kernelId: string;
  sessionId: string;
  blobId: string;
  turnId: string | null;
  createdAtMs: number;
};

export type SessionBlobRowInsert = {
  id: string;
  kernelId?: string;
  sessionId: string;
  blobId: string;
  turnId?: string | null;
  createdAtMs: number;
};

export type ScmResourceScope = "kernel" | "project";
export type ScmResourceKind = "policy" | "bot" | "command" | "behavior";

export type ScmResourceRow = {
  id: string;
  kernelId: string;
  scope: ScmResourceScope;
  scopeId: string;
  kind: ScmResourceKind;
  name: string;
  source: string;
  sha256: string;
  updatedAtMs: number;
};

export type ScmResourceRowInsert = {
  id: string;
  kernelId?: string;
  scope: ScmResourceScope;
  scopeId: string;
  kind: ScmResourceKind;
  name: string;
  source: string;
  sha256: string;
  updatedAtMs: number;
};

export type PluginStateScope = "global" | "project";

export type PluginStateLogRow = {
  id: string;
  kernelId: string;
  plugin: string;
  scope: PluginStateScope;
  scopeId: string;
  namespace: string;
  logJson: string;
  updatedAtMs: number;
};

export type PluginStateLogRowInsert = {
  id: string;
  kernelId?: string;
  plugin: string;
  scope: PluginStateScope;
  scopeId: string;
  namespace?: string;
  logJson?: string;
  updatedAtMs: number;
};
