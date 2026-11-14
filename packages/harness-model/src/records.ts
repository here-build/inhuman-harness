import type { KernelStateRow, PendingAskRow, SessionRow, SessionTurnRow } from "@inhuman.tools/harness-contract";
import {
  kernelStateTable,
  pendingAsksTable,
  sessionsTable,
  sessionTurnsTable,
} from "@inhuman.tools/harness-contract/schema";
import { column, model, Model } from "@inhuman.tools/model";

@model("harness:record:kernel-state", kernelStateTable)
export class KernelRecord extends Model<KernelStateRow> {
  @column(kernelStateTable.id) accessor id!: string;
  @column(kernelStateTable.defaultModel) accessor defaultModel!: string;
  @column(kernelStateTable.permissionMode) accessor permissionMode!: string;
  @column(kernelStateTable.kvsJson) accessor kvsJson!: string;
  @column(kernelStateTable.updatedAtMs) accessor updatedAtMs!: number;

  constructor(row?: Partial<KernelStateRow> | symbol) {
    super(row as Record<string, unknown> | undefined);
  }
}

@model("harness:record:session-summary", sessionsTable)
export class SessionSummaryRecord extends Model<SessionRow> {
  @column(sessionsTable.sessionId) accessor sessionId!: string;
  @column(sessionsTable.title) accessor title!: string;
  @column(sessionsTable.workspacePath) accessor workspacePath!: string;
  @column(sessionsTable.mode) accessor mode!: "assistant" | "agentic";
  @column(sessionsTable.permissionMode) accessor permissionMode!: string;
  @column(sessionsTable.running) accessor running!: boolean;
  @column(sessionsTable.headTurnId) accessor headTurnId!: string | null;
  @column(sessionsTable.parentSessionId) accessor parentSessionId!: string | null;
  @column(sessionsTable.parentCallId) accessor parentCallId!: string | null;
  @column(sessionsTable.depth) accessor depth!: number;
  @column(sessionsTable.revision) accessor revision!: number;
  @column(sessionsTable.createdAtMs) accessor createdAtMs!: number;
  @column(sessionsTable.lastActiveAtMs) accessor lastActiveAtMs!: number;
  @column(sessionsTable.archivedAtMs) accessor archivedAtMs!: number | null;

  constructor(row?: Partial<SessionRow> | symbol) {
    super(row as Record<string, unknown> | undefined);
  }
}

@model("harness:record:pending-ask", pendingAsksTable)
export class PendingAskRecord extends Model<PendingAskRow> {
  @column(pendingAsksTable.jobId) accessor jobId!: string;
  @column(pendingAsksTable.sessionId) accessor sessionId!: string;
  @column(pendingAsksTable.turnId) accessor turnId!: string;
  @column(pendingAsksTable.kind) accessor kind!: "ask" | "ack";
  @column(pendingAsksTable.object) accessor object!: string;
  @column(pendingAsksTable.summary) accessor summary!: string;
  @column(pendingAsksTable.createdAtMs) accessor createdAtMs!: number;

  constructor(row?: Partial<PendingAskRow> | symbol) {
    super(row as Record<string, unknown> | undefined);
  }
}

@model("harness:record:session-turn", sessionTurnsTable)
export class SessionTurnRecord extends Model<SessionTurnRow> {
  @column(sessionTurnsTable.turnId) accessor turnId!: string;
  @column(sessionTurnsTable.sessionId) accessor sessionId!: string;
  @column(sessionTurnsTable.ordinal) accessor ordinal!: number;
  @column(sessionTurnsTable.prompt) accessor prompt!: string;
  @column(sessionTurnsTable.status) accessor status!: "running" | "completed" | "cancelled" | "failed" | "interrupted";
  @column(sessionTurnsTable.cancelRequested) accessor cancelRequested!: boolean;
  @column(sessionTurnsTable.reducerExited) accessor reducerExited!: boolean;
  @column(sessionTurnsTable.startedAtMs) accessor startedAtMs!: number;
  @column(sessionTurnsTable.endedAtMs) accessor endedAtMs!: number | null;

  constructor(row?: Partial<SessionTurnRow> | symbol) {
    super(row as Record<string, unknown> | undefined);
  }
}
