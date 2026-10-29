/**
 * One scope tree. A missing config cell inherits from the parent.
 * Last-used models overlay the same way. Pane keys, model usage, and agent
 * calls stay on this scope. `trusted` and `contentHash` sit on the scope row.
 * `revision` is only the compare-and-set witness for that row.
 * The cloud runtime applies {@link schemaSql}. Adapters store the same cells.
 */

export const tableNames = [
  "scopes",
  "config",
  "kv",
  "roster",
  "overviews",
  "generations",
  "termContinue",
  "modelUsage",
  "lastUsedModel",
  "agentCalls",
] as const;

export type TableName = (typeof tableNames)[number];

export type CellKind = "string" | "number" | "boolean";

export type Column = {
  readonly name: string;
  readonly sql: string;
  readonly kind: CellKind;
  readonly required: boolean;
};

export type TableDef = {
  readonly name: TableName;
  readonly sql: string;
  readonly key: string;
  readonly keySql: string;
  readonly columns: readonly Column[];
};

function column(name: string, sql: string, kind: CellKind, required = false): Column {
  return { name, sql, kind, required };
}

const configColumns: readonly Column[] = [
  column("defaultPermissionMode", "default_permission_mode", "string"),
  column("compactStrategy", "compact_strategy", "string"),
  column("autoModeClassifier", "auto_mode_classifier", "string"),
  column("compactHard", "compact_hard", "string"),
  column("compactSoft", "compact_soft", "string"),
  column("compactKeepTurns", "compact_keep_turns", "number"),
  column("contextGlowRemaining", "context_glow_remaining", "string"),
  column("speculativePolicyProcessingTools", "speculative_policy_processing_tools", "number"),
  column("approvalAskThrottleMs", "approval_ask_throttle_ms", "number"),
  column("shellTailBytes", "shell_tail_bytes", "number"),
  column("superKey", "super_key", "string"),
  column("hideFloorTools", "hide_floor_tools", "boolean"),
  column("statusline", "statusline", "string"),
  column("statuslineRefresh", "statusline_refresh", "string"),
  column("reActLoopIntentDetectedTrigger", "re_act_loop_intent_detected_trigger", "boolean"),
];

const overviewColumns: readonly Column[] = [
  column("scopeId", "scope_id", "string", true),
  column("title", "title", "string", true),
  column("lastMessageAt", "last_message_at", "number"),
  column("recipeScope", "recipe_scope", "string", true),
  column("specName", "spec_name", "string", true),
  column("resident", "resident", "boolean", true),
  column("keepAlive", "keep_alive", "boolean", true),
  column("oneShot", "one_shot", "boolean", true),
  column("model", "model", "string", true),
  column("status", "status", "string", true),
  column("midMotion", "mid_motion", "boolean", true),
  column("openTurn", "open_turn", "boolean", true),
  column("openToolCount", "open_tool_count", "number", true),
  column("periodArmed", "period_armed", "boolean", true),
  column("openCallbackCount", "open_callback_count", "number", true),
  column("asking", "asking", "boolean", true),
  column("unfinished", "unfinished", "string", true),
  column("lastPrompt", "last_prompt", "string", true),
  column("askLine", "ask_line", "string", true),
  column("questionLine", "question_line", "string", true),
];

export const tables: { readonly [Name in TableName]: TableDef } = {
  scopes: {
    name: "scopes",
    sql: "scopes",
    key: "id",
    keySql: "id",
    columns: [
      column("parentId", "parent_id", "string", true),
      column("path", "path", "string", true),
      column("trusted", "trusted", "boolean"),
      column("contentHash", "content_hash", "string"),
      column("revision", "revision", "number", true),
    ],
  },
  config: {
    name: "config",
    sql: "config",
    key: "scopeId",
    keySql: "scope_id",
    columns: [column("generation", "generation", "number", true), ...configColumns],
  },
  kv: {
    name: "kv",
    sql: "kv",
    key: "id",
    keySql: "id",
    columns: [
      column("scopeId", "scope_id", "string", true),
      column("key", "key", "string", true),
      column("value", "value", "string", true),
    ],
  },
  roster: {
    name: "roster",
    sql: "roster",
    key: "id",
    keySql: "id",
    columns: [
      column("scopeId", "scope_id", "string", true),
      column("name", "name", "string", true),
      column("sessionId", "session_id", "string", true),
    ],
  },
  overviews: {
    name: "overviews",
    sql: "overviews",
    key: "sessionId",
    keySql: "session_id",
    columns: overviewColumns,
  },
  generations: {
    name: "generations",
    sql: "generations",
    key: "sessionId",
    keySql: "session_id",
    columns: [
      column("scopeId", "scope_id", "string", true),
      column("generation", "generation", "number", true),
      column("holder", "holder", "string", true),
    ],
  },
  termContinue: {
    name: "termContinue",
    sql: "term_continue",
    key: "id",
    keySql: "id",
    columns: [
      column("scopeId", "scope_id", "string", true),
      column("key", "key", "string", true),
      column("sessionId", "session_id", "string", true),
    ],
  },
  modelUsage: {
    name: "modelUsage",
    sql: "model_usage",
    key: "id",
    keySql: "id",
    columns: [
      column("scopeId", "scope_id", "string", true),
      column("key", "key", "string", true),
      column("at", "at", "number", true),
    ],
  },
  lastUsedModel: {
    name: "lastUsedModel",
    sql: "last_used_model",
    key: "id",
    keySql: "id",
    columns: [
      column("scopeId", "scope_id", "string", true),
      column("connection", "connection", "string", true),
      column("model", "model", "string", true),
    ],
  },
  agentCalls: {
    name: "agentCalls",
    sql: "agent_calls",
    key: "id",
    keySql: "id",
    columns: [
      column("scopeId", "scope_id", "string", true),
      column("callerSessionId", "caller_session_id", "string", true),
      column("workerSessionId", "worker_session_id", "string", true),
      column("spec", "spec", "string", true),
      column("oneShot", "one_shot", "boolean", true),
      column("completed", "completed", "boolean", true),
    ],
  },
};

export const configFieldNames = configColumns.map((field) => field.name);

export type ConfigField = (typeof configColumns)[number]["name"];

export function columnOf(table: TableName, name: string): Column | undefined {
  return tables[table].columns.find((field) => field.name === name);
}

function sqlType(kind: CellKind, required: boolean): string {
  const base = kind === "number" ? "bigint" : kind === "boolean" ? "boolean" : "text";
  return required ? `${base} NOT NULL` : base;
}

/** DDL for the server database Electric replicates. */
export function schemaSql(): string {
  const body = tableNames
    .map((name) => {
      const table = tables[name];
      const columns = [
        `  ${table.keySql} text PRIMARY KEY`,
        ...table.columns.map((field) => `  ${field.sql} ${sqlType(field.kind, field.required)}`),
      ];
      const extra: string[] = [];
      if (name !== "scopes") extra.push("  FOREIGN KEY (scope_id) REFERENCES scopes (id)");
      if (name === "kv" || name === "termContinue" || name === "modelUsage") extra.push("  UNIQUE (scope_id, key)");
      if (name === "roster") extra.push("  UNIQUE (scope_id, name)");
      if (name === "lastUsedModel") extra.push("  UNIQUE (scope_id, connection)");
      return `CREATE TABLE ${table.sql} (\n${[...columns, ...extra].join(",\n")}\n);`;
    })
    .join("\n\n");
  const indexes = [
    "kv",
    "roster",
    "overviews",
    "generations",
    "term_continue",
    "model_usage",
    "last_used_model",
    "agent_calls",
  ]
    .map((name) => `CREATE INDEX ${name}_scope ON ${name} (scope_id);`)
    .join("\n");
  return `-- NULL config columns inherit from the parent scope.\n\n${body}\n\n${indexes}\n`;
}
