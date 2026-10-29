/**
 * MCP tape identity: dim server, bright split action. Options dump is the
 * composer stack (same T-join as slash), not the ask pin. pretty-mcp
 * identity wins when the catalog covers this server+tool.
 *
 * Split matches the catalog name-floor (`score-names.mjs`): camel + `_`/`-`/`.`
 * and `graph`+`ql` → `graphql`. Display is a preserve map, not title-case's
 * small-word list (that list un-capitalizes; we keep ID / URL / GraphQL).
 */
import { MCPToolJob } from "@inhuman.tools/harness-model";

const PRESERVE: Readonly<Record<string, string>> = {
  id: "ID",
  url: "URL",
  uri: "URI",
  api: "API",
  http: "HTTP",
  https: "HTTPS",
  json: "JSON",
  html: "HTML",
  css: "CSS",
  xml: "XML",
  sql: "SQL",
  csv: "CSV",
  pdf: "PDF",
  uuid: "UUID",
  oauth: "OAuth",
  graphql: "GraphQL",
  github: "GitHub",
  gitlab: "GitLab",
  mcp: "MCP",
  aws: "AWS",
  gcp: "GCP",
  ssh: "SSH",
  jwt: "JWT",
  dns: "DNS",
  ip: "IP",
  pr: "PR",
  ui: "UI",
  sdk: "SDK",
  cli: "CLI",
  tui: "TUI",
  rpc: "RPC",
  sse: "SSE",
};

export type McpIdentity = {
  readonly server: string;
  readonly action: string;
};

export function splitName(name: string): string[] {
  const marked = name.replaceAll(/([a-z0-9])([A-Z])/g, "$1\0$2").replaceAll(/([A-Z]+)([A-Z][a-z])/g, "$1\0$2");
  const raw = marked
    .split(/[\0_\-./]+/)
    .filter(Boolean)
    .map((part) => part.toLowerCase());
  const out: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "graph" && raw[i + 1] === "ql") {
      out.push("graphql");
      i++;
    } else {
      out.push(raw[i]!);
    }
  }
  return out;
}

export function parseMcpWireName(name: string): { server: string; tool: string } {
  if (!name.startsWith("mcp__")) return { server: "", tool: name };
  const rest = name.slice("mcp__".length);
  const split = rest.indexOf("__");
  if (split === -1) return { server: rest, tool: "" };
  return { server: rest.slice(0, split), tool: rest.slice(split + 2) };
}

function displayToken(token: string, voice: "server" | "action"): string {
  const preserved = PRESERVE[token];
  if (preserved !== undefined) return preserved;
  if (voice === "action") return token;
  if (token.length === 0) return token;
  return token.charAt(0).toUpperCase() + token.slice(1);
}

function displayWords(tokens: readonly string[], voice: "server" | "action"): string {
  return tokens.map((token) => displayToken(token, voice)).join(" ");
}

function stripServerPrefix(toolTokens: string[], serverTokens: string[]): string[] {
  if (
    serverTokens.length > 0 &&
    serverTokens.length <= toolTokens.length &&
    serverTokens.every((token, i) => token === toolTokens[i])
  ) {
    return toolTokens.slice(serverTokens.length);
  }
  return toolTokens;
}

export function mcpIdentity(work: MCPToolJob): McpIdentity {
  const wired = parseMcpWireName(work.name);
  const serverKey = work.connectionKey.trim() || wired.server;
  const toolName = work.serverToolName.trim() || wired.tool || work.name;
  const serverTokens = splitName(serverKey);
  const toolTokens = splitName(toolName);
  const actionTokens = stripServerPrefix(toolTokens, serverTokens);
  return {
    server: displayWords(serverTokens.length > 0 ? serverTokens : ["mcp"], "server"),
    action: displayWords(actionTokens.length > 0 ? actionTokens : toolTokens, "action") || toolName,
  };
}

function isPrimitive(value: unknown): boolean {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function formatArgValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) return "null";
  if (Array.isArray(value) && value.every(isPrimitive)) {
    return value.map((item) => (item === null ? "null" : String(item))).join(", ");
  }
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return String(value);
  }
}

/** Visible rows in the MCP confirm stack. Same chrome as slash; clip is 70vh − 3. */
export function mcpConfirmViewport(rows: number): number {
  return Math.max(1, Math.floor(rows * 0.7) - 3);
}

/** Key/value dump for the confirm stack. Empty object is empty — no `{}`. */
export function formatMcpArgs(args: Record<string, unknown> | null): string {
  if (args === null) return "";
  const lines: string[] = [];
  for (const key of Object.keys(args)) {
    const value = args[key];
    if (value === undefined) continue;
    const rendered = formatArgValue(value);
    lines.push(rendered.includes("\n") ? `${key}\n${rendered}` : `${key}  ${rendered}`);
  }
  return lines.join("\n");
}
