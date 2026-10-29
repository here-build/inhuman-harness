/**
 * A global bot names unpinned MCP connections. A project or session bot names
 * connections whose settings.project is the project it runs in.
 */

export type RecipeScope = "session" | "project" | "global";

export type McpConnectionFace = {
  readonly name?: string;
  readonly configuration?: { readonly [key: string]: unknown };
  readonly live?: { readonly tools?: unknown } | null;
  readonly driver?: { readonly abilityClaim?: readonly string[] } | null;
};

export type McpGrantDraft = {
  readonly server: string;
  readonly tools: string;
  readonly account: string;
  readonly session: string;
};

export type McpGrant = {
  readonly server: string;
  readonly tools?: readonly string[];
  readonly account?: string;
  readonly session?: string;
};

export type McpServerOption = {
  readonly server: string;
  readonly accounts: readonly string[];
  readonly sessions: readonly string[];
  readonly tools: readonly string[];
};

export function mcpPoolCaption(recipeScope: RecipeScope, projectPath: string): string {
  if (recipeScope === "global") return "Global MCP servers";
  if (projectPath === "") return "Open a project to choose its MCP servers.";
  return "MCP servers pinned to this project";
}

export function mcpServerOptions(
  connections: Readonly<Record<string, McpConnectionFace | undefined>>,
  recipeScope: RecipeScope,
  projectPath: string,
): readonly McpServerOption[] {
  const grouped = new Map<string, { accounts: Set<string>; sessions: Set<string>; tools: Set<string> }>();
  for (const [id, spec] of Object.entries(connections)) {
    if (spec == null || id.startsWith("__")) continue;
    if (spec.driver?.abilityClaim?.includes("mcp") !== true) continue;
    const project = configText(spec.configuration, "project");
    if (!inPool(recipeScope, project, projectPath)) continue;
    const server = (spec.name ?? "").trim() || id;
    const row = grouped.get(server) ?? {
      accounts: new Set<string>(),
      sessions: new Set<string>(),
      tools: new Set<string>(),
    };
    const account = configText(spec.configuration, "account") || configText(spec.configuration, "accountId");
    const session = configText(spec.configuration, "session") || configText(spec.configuration, "sessionId");
    if (account !== "") row.accounts.add(account);
    if (session !== "") row.sessions.add(session);
    for (const tool of toolNames(spec.live?.tools)) row.tools.add(tool);
    grouped.set(server, row);
  }
  return [...grouped.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([server, row]) => ({
      server,
      accounts: [...row.accounts].sort(),
      sessions: [...row.sessions].sort(),
      tools: [...row.tools].sort(),
    }));
}

/** Keeps a grant whose server is not in the pool, so a save does not drop it. */
export function serverChoices(options: readonly McpServerOption[], current: string): readonly McpServerOption[] {
  const server = current.trim();
  if (server === "" || options.some((option) => option.server === server)) return options;
  return [...options, { server, accounts: [], sessions: [], tools: [] }];
}

export function mcpOption(options: readonly McpServerOption[], server: string): McpServerOption | undefined {
  return serverChoices(options, server).find((option) => option.server === server);
}

export function mcpHint(option: McpServerOption | undefined, field: "tools" | "account" | "session"): string {
  if (field === "tools") {
    if (option == null || option.tools.length === 0) return "all tools";
    return `all, or ${option.tools.join(", ")}`;
  }
  if (field === "account") {
    if (option == null || option.accounts.length === 0) return "any account";
    return option.accounts.join(", ");
  }
  if (option == null || option.sessions.length === 0) return "any session";
  return option.sessions.join(", ");
}

export function mcpDrafts(text: string | null | undefined): McpGrantDraft[] {
  const trimmed = text?.trim() ?? "";
  if (trimmed === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  return draftsFrom(parsed);
}

export function mcpPayload(drafts: readonly McpGrantDraft[]): readonly McpGrant[] {
  const out: McpGrant[] = [];
  for (const draft of drafts) {
    const server = draft.server.trim();
    if (server === "") continue;
    const tools = splitList(draft.tools);
    const account = draft.account.trim();
    const session = draft.session.trim();
    out.push({
      server,
      ...(tools.length === 0 ? {} : { tools }),
      ...(account === "" ? {} : { account }),
      ...(session === "" ? {} : { session }),
    });
  }
  return out;
}

export function mcpServerLine(text: string | null | undefined): string {
  return mcpDrafts(text)
    .map((grant) => grant.server)
    .filter((server) => server !== "")
    .join(", ");
}

function inPool(recipeScope: RecipeScope, project: string, projectPath: string): boolean {
  if (recipeScope === "global") return project === "";
  return projectPath !== "" && project === projectPath;
}

function draftsFrom(value: unknown): McpGrantDraft[] {
  if (!Array.isArray(value)) return [];
  const out: McpGrantDraft[] = [];
  for (const item of value) {
    if (item == null || typeof item !== "object") continue;
    const record = recordOf(item);
    const server = textValue(record.server);
    if (server === "") continue;
    out.push({
      server,
      tools: toolsText(record.tools),
      account: textValue(record.account),
      session: textValue(record.session),
    });
  }
  return out;
}

function recordOf(value: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) out[key] = entry;
  return out;
}

function configText(configuration: { readonly [key: string]: unknown } | undefined, key: string): string {
  return textValue(configuration?.[key]);
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function toolsText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!Array.isArray(value)) return "";
  return value
    .filter((item): item is string => typeof item === "string" && item.trim() !== "")
    .map((item) => item.trim())
    .join(", ");
}

function toolNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const item of value) {
    if (typeof item === "string" && item.trim() !== "") {
      names.push(item.trim());
      continue;
    }
    if (item == null || typeof item !== "object") continue;
    const record = recordOf(item);
    const name = textValue(record.serverToolName) || textValue(record.name);
    if (name !== "") names.push(name);
  }
  return names;
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
}
