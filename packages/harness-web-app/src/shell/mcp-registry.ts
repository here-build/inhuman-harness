/**
 * Login state for an MCP connection, and which connected copies match a
 * registry install string. Secrets stay on the daemon. The line is read from
 * the live account the connection already reports.
 */
import { connectError } from "./connect-error.js";
import type { AccountSource } from "./wire-account.js";

export type RegistryHit = {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly install: string;
};

export type McpFace = AccountSource & {
  readonly name?: string;
  readonly configuration?: { readonly [key: string]: unknown };
  readonly driver?: { readonly name?: string; readonly abilityClaim?: readonly string[] } | null;
};

export type McpCopy = {
  readonly id: string;
  readonly name: string;
  readonly login: string;
};

/** Rows from `mcp-server/search`. A row without a name or title is skipped. */
export function registryHits(result: unknown): RegistryHit[] {
  const servers = field(result, "servers");
  if (!Array.isArray(servers)) return [];
  const hits: RegistryHit[] = [];
  for (const row of servers) {
    const name = text(field(row, "name"));
    const title = text(field(row, "title"));
    if (name === "" || title === "") continue;
    hits.push({
      name,
      title,
      description: text(field(row, "description")),
      install: text(field(row, "install")),
    });
  }
  return hits;
}

/** The install string a connection was adopted with: its URL, or its command line. */
export function connectionInstall(configuration: { readonly [key: string]: unknown } | undefined): string {
  if (configuration === undefined) return "";
  const url = text(configuration.url);
  if (url !== "") return collapse(url);
  const command = text(configuration.command);
  if (command === "") return "";
  return collapse([command, ...stringList(configuration.args)].join(" "));
}

/**
 * What to say about this server's login.
 * A dead socket wins over a login prompt. HTTP with no reported person is
 * signed in once the driver is ready, and signed out while it is idle.
 * A stdio process has no login: it is Ready or Idle.
 */
export function mcpLoginLine(spec: McpFace, provider = ""): string {
  const name = provider.trim() === "" ? (spec.driver?.name ?? "") : provider.trim();
  const error = typeof spec.error === "string" ? spec.error : "";
  const failure = spec.readyState === "failed" && error !== "" ? connectError(name, error) : null;
  const needsAuth = text(field(spec.live, "auth")) === "needs-auth";
  if (failure?.kind === "connection") return failure.summary;
  if (failure?.kind === "auth" || needsAuth) return "Log in";
  if (spec.readyState === "failed") return "Failed";
  if (spec.readyState === "bootstrapping" || spec.readyState === "connecting") return "Connecting";
  if (!isHttp(spec)) return spec.readyState === "ready" ? "Ready" : "Idle";
  const who = person(spec);
  if (who !== "" && spec.readyState === "ready") return `Signed in as ${who}`;
  if (spec.readyState === "ready") return "Signed in";
  return "Signed out";
}

/** Connected MCP copies whose install string is this one. Each keeps its own login. */
export function mcpCopies(rows: readonly (readonly [string, McpFace])[], install: string): McpCopy[] {
  const wanted = collapse(install);
  if (wanted === "") return [];
  const copies: McpCopy[] = [];
  for (const [id, spec] of rows) {
    if (id.startsWith("__") || !isMcp(spec)) continue;
    if (collapse(connectionInstall(spec.configuration)) !== wanted) continue;
    const name = shown(spec.name, id);
    copies.push({ id, name, login: mcpLoginLine(spec, name) });
  }
  return copies;
}

/** Description, then each copy's login. No copies yet says so. */
export function registryDetail(description: string, copies: readonly McpCopy[]): string {
  const lines = [description.trim()];
  if (copies.length === 0) lines.push("Not connected");
  for (const copy of copies) lines.push(`${copy.name} · ${copy.login}`);
  return lines.filter((line) => line !== "").join("\n");
}

/** Empty while the field is empty or results are showing. */
export function registryStatus(query: string, pending: boolean, hits: number): string {
  if (query.trim() === "") return "";
  if (pending) return "Searching…";
  if (hits === 0) return "No servers match.";
  return "";
}

export function registryAddWord(install: string, copies: number): string {
  if (install.trim() === "") return "No install";
  if (copies === 0) return "Add";
  return "Add another";
}

export function registryAddLabel(title: string, install: string, copies: number): string {
  if (install.trim() === "") return `No install published for ${title}`;
  if (copies === 0) return `Add ${title}`;
  return `Add another ${title}`;
}

function isHttp(spec: McpFace): boolean {
  if (spec.driver?.name === "mcp-http") return true;
  if (spec.driver?.name === "mcp-stdio") return false;
  return text(spec.configuration?.url).startsWith("http");
}

function isMcp(spec: McpFace): boolean {
  if (spec.driver?.abilityClaim?.includes("mcp") === true) return true;
  const name = spec.driver?.name ?? "";
  return name === "mcp-http" || name === "mcp-stdio";
}

function person(spec: McpFace): string {
  const identity = field(spec.live, "identity");
  const name = text(field(identity, "displayName"));
  if (name !== "") return name;
  return text(field(identity, "email"));
}

function shown(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? fallback : trimmed;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const items: string[] = [];
  for (const item of value) {
    const line = text(item);
    if (line !== "") items.push(line);
  }
  return items;
}

function collapse(value: string): string {
  return value.trim().replaceAll(/\s+/g, " ");
}

function field(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  if (!Object.hasOwn(value, key)) return undefined;
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
