/**
 * A bot names an MCP server. The connection's project pin decides the pool:
 * a global bot sees connections with no project, and a project or session
 * bot sees connections pinned to the session's project.
 */
import { botMcpGrantSchema, type BotMcpGrant } from "@/extensions/schemas";

export type McpServerFace = {
  readonly id: string;
  readonly name: string;
  /** Empty when the connection is global. Otherwise the project root path. */
  readonly project: string;
  readonly account: string;
  readonly session: string;
};

const facesByCatalog = new WeakMap<object, ReadonlyMap<string, McpServerFace>>();

export function bindMcpFaces(catalog: object, faces: ReadonlyMap<string, McpServerFace>): void {
  facesByCatalog.set(catalog, faces);
}

export function clearMcpFaces(catalog: object): void {
  facesByCatalog.delete(catalog);
}

export function mcpFaceOf(catalog: object, connectionKey: string): McpServerFace | undefined {
  return facesByCatalog.get(catalog)?.get(connectionKey);
}

/** `configuration.project` pins a connection. Without it the connection is global. */
export function mcpServerFace(
  id: string,
  spec: { readonly name: string; readonly configuration: unknown },
): McpServerFace {
  const bag = record(spec.configuration);
  return {
    id,
    name: spec.name.trim(),
    project: fieldText(bag, "project"),
    account: fieldText(bag, "account") || fieldText(bag, "accountId"),
    session: fieldText(bag, "session") || fieldText(bag, "sessionId"),
  };
}

export function mcpJsonOf(grants: readonly BotMcpGrant[]): string {
  if (grants.length === 0) return "";
  return JSON.stringify(
    grants.map((grant) => {
      const row: Record<string, unknown> = { server: grant.server };
      if (grant.tools != null) row.tools = [...grant.tools];
      if (grant.account != null) row.account = grant.account;
      if (grant.session != null) row.session = grant.session;
      return row;
    }),
  );
}

export function parseBotMcp(text: string): readonly BotMcpGrant[] {
  const trimmed = text.trim();
  if (trimmed === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  const result = botMcpGrantSchema.array().safeParse(parsed);
  return result.success ? result.data : [];
}

/**
 * Global bots reach unpinned connections. Every other scope reaches the
 * connection pinned to `projectPath`. A grant with no tool list is the
 * whole server; `account` and `session` must match when the grant sets them.
 */
export function botMcpAllows(
  bot: { readonly recipeScope: "session" | "project" | "global"; readonly mcpJson: string },
  face: McpServerFace,
  tool: string,
  projectPath: string,
): boolean {
  const grants = parseBotMcp(bot.mcpJson);
  if (grants.length === 0) return false;
  if (bot.recipeScope === "global") {
    if (face.project !== "") return false;
  } else if (face.project === "" || face.project !== projectPath) {
    return false;
  }
  return grants.some((grant) => grantMatches(grant, face, tool));
}

function grantMatches(grant: BotMcpGrant, face: McpServerFace, tool: string): boolean {
  if (grant.server !== face.name && grant.server !== face.id) return false;
  if (grant.account !== undefined && grant.account !== face.account) return false;
  if (grant.session !== undefined && grant.session !== face.session) return false;
  if (grant.tools !== undefined && !grant.tools.includes(tool)) return false;
  return true;
}

function record(value: unknown): Record<string, unknown> | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) out[key] = entry;
  return out;
}

function fieldText(bag: Record<string, unknown> | null, key: string): string {
  const value = bag?.[key];
  return typeof value === "string" ? value.trim() : "";
}

export { type BotMcpGrant } from "@/extensions/schemas";
