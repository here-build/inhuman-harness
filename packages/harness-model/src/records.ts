import type {
  KernelStateRow,
  PendingAskRow,
  PluginStateLogRow,
  PluginStateScope,
  ProjectKind,
  ProjectRow,
  ScmResourceKind,
  ScmResourceRow,
  ScmResourceScope,
  SessionRow,
  SessionTurnRow,
} from "@inhuman.tools/harness-contract";
import {
  kernelStateTable,
  pendingAsksTable,
  pluginStateLogsTable,
  projectsTable,
  scmResourcesTable,
  sessionsTable,
  sessionTurnsTable,
} from "@inhuman.tools/harness-contract/schema";
import { column, model, Model } from "@inhuman.tools/model";

@model("harness:record:kernel-state", kernelStateTable)
export class KernelRecord extends Model<KernelStateRow> {
  @column(kernelStateTable.id) accessor id!: string;
  @column(kernelStateTable.kernelId) accessor kernelId!: string;
  @column(kernelStateTable.defaultModel) accessor defaultModel!: string;
  @column(kernelStateTable.permissionMode) accessor permissionMode!: string;
  @column(kernelStateTable.enabledPluginsJson) accessor enabledPluginsJson!: string;
  @column(kernelStateTable.kvsJson) accessor kvsJson!: string;
  @column(kernelStateTable.updatedAtMs) accessor updatedAtMs!: number;

  constructor(row?: Partial<KernelStateRow> | symbol) {
    super(row as Record<string, unknown> | undefined);
  }
}

@model("harness:record:project", projectsTable)
export class ProjectRecord extends Model<ProjectRow> {
  @column(projectsTable.projectId) accessor projectId!: string;
  @column(projectsTable.kernelId) accessor kernelId!: string;
  @column(projectsTable.title) accessor title!: string;
  @column(projectsTable.kind) accessor kind!: ProjectKind;
  @column(projectsTable.workspacePath) accessor workspacePath!: string | null;
  @column(projectsTable.defaultPermissionMode) accessor defaultPermissionMode!: string;
  @column(projectsTable.authorizationJson) accessor authorizationJson!: string;
  @column(projectsTable.kvsJson) accessor kvsJson!: string;
  @column(projectsTable.lastUsedModelJson) accessor lastUsedModelJson!: string;
  @column(projectsTable.enabledPluginsJson) accessor enabledPluginsJson!: string;
  @column(projectsTable.pluginConfigsJson) accessor pluginConfigsJson!: string;
  @column(projectsTable.botsRosterJson) accessor botsRosterJson!: string;
  @column(projectsTable.trusted) accessor trusted!: boolean;
  @column(projectsTable.contentHash) accessor contentHash!: string | null;
  @column(projectsTable.revision) accessor revision!: number;
  @column(projectsTable.updatedAtMs) accessor updatedAtMs!: number;

  constructor(row?: Partial<ProjectRow> | symbol) {
    super(row as Record<string, unknown> | undefined);
  }
}

@model("harness:record:session-summary", sessionsTable)
export class SessionSummaryRecord extends Model<SessionRow> {
  @column(sessionsTable.sessionId) accessor sessionId!: string;
  @column(sessionsTable.kernelId) accessor kernelId!: string;
  @column(sessionsTable.projectId) accessor projectId!: string;
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
  @column(pendingAsksTable.kernelId) accessor kernelId!: string;
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
  @column(sessionTurnsTable.kernelId) accessor kernelId!: string;
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

@model("harness:record:scm-resource", scmResourcesTable)
export class ScmResourceRecord extends Model<ScmResourceRow> {
  @column(scmResourcesTable.id) accessor id!: string;
  @column(scmResourcesTable.kernelId) accessor kernelId!: string;
  @column(scmResourcesTable.scope) accessor scope!: ScmResourceScope;
  @column(scmResourcesTable.scopeId) accessor scopeId!: string;
  @column(scmResourcesTable.kind) accessor kind!: ScmResourceKind;
  @column(scmResourcesTable.name) accessor name!: string;
  @column(scmResourcesTable.source) accessor source!: string;
  @column(scmResourcesTable.sha256) accessor sha256!: string;
  @column(scmResourcesTable.updatedAtMs) accessor updatedAtMs!: number;

  constructor(row?: Partial<ScmResourceRow> | symbol) {
    super(row as Record<string, unknown> | undefined);
  }
}

@model("harness:record:plugin-state-log", pluginStateLogsTable)
export class PluginStateLogRecord extends Model<PluginStateLogRow> {
  @column(pluginStateLogsTable.id) accessor id!: string;
  @column(pluginStateLogsTable.kernelId) accessor kernelId!: string;
  @column(pluginStateLogsTable.plugin) accessor plugin!: string;
  @column(pluginStateLogsTable.scope) accessor scope!: PluginStateScope;
  @column(pluginStateLogsTable.scopeId) accessor scopeId!: string;
  @column(pluginStateLogsTable.namespace) accessor namespace!: string;
  @column(pluginStateLogsTable.logJson) accessor logJson!: string;
  @column(pluginStateLogsTable.updatedAtMs) accessor updatedAtMs!: number;

  constructor(row?: Partial<PluginStateLogRow> | symbol) {
    super(row as Record<string, unknown> | undefined);
  }
}
