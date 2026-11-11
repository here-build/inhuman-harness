/**
 * Pure TypeScript row & insert types for the canonical Harness tables.
 * Kept free of `drizzle-orm` imports so browser, SDK, and non-SQLite runtimes
 * (`@inhuman.tools/turn`, ElectricSQL, `skipLibCheck: false` consumers) depend
 * only on plain structural types; `sqlite.ts` verifies compile-time identity
 * against the Drizzle `sqliteTable` definitions.
 */

export type KernelStateRow = {
  id: string;
  defaultModel: string;
  permissionMode: string;
  kvsJson: string;
  updatedAtMs: number;
};

export type KernelStateRowInsert = {
  id?: string;
  defaultModel?: string;
  permissionMode?: string;
  kvsJson?: string;
  updatedAtMs: number;
};

export type KernelRow = KernelStateRow;

export type ScopeNodeRow = {
  id: string;
  scopeId: string;
  nodeId: string;
  tag: string;
  isRoot: boolean;
  revision: number;
  rowJson: string;
};

export type ScopeNodeRowInsert = {
  id: string;
  scopeId: string;
  nodeId: string;
  tag: string;
  isRoot?: boolean;
  revision: number;
  rowJson: string;
};

export type SessionRow = {
  sessionId: string;
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
  sessionId: string;
  nodeId: string;
  tag: string;
  isRoot: boolean;
  revision: number;
  rowJson: string;
};

export type SessionNodeRowInsert = {
  id: string;
  sessionId: string;
  nodeId: string;
  tag: string;
  isRoot?: boolean;
  revision: number;
  rowJson: string;
};

export type SessionEffectRow = {
  id: string;
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
  sessionId: string;
  blobId: string;
  turnId: string | null;
  createdAtMs: number;
};

export type SessionBlobRowInsert = {
  id: string;
  sessionId: string;
  blobId: string;
  turnId?: string | null;
  createdAtMs: number;
};
