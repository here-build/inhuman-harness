/**
 * Official MCP registry search.
 * `GET /v0.1/servers` matches the server name, not the description.
 * The install string is the first streamable HTTP or SSE remote, otherwise
 * the first package command. Adopt that string as `input`, so each copy
 * keeps its own login.
 */

const REGISTRY_SERVERS = "https://registry.modelcontextprotocol.io/v0.1/servers";

export type RegistryServer = {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly install: string;
};

export type RegistryFetch = (url: URL, init?: RequestInit) => Promise<Response>;

export type RegistrySearchOptions = {
  readonly limit?: number;
  readonly signal?: AbortSignal;
  readonly fetch?: RegistryFetch;
};

/** Latest official-registry rows whose name contains `query`. An empty query matches nothing. */
export async function searchOfficialRegistry(
  query: string,
  options: RegistrySearchOptions = {},
): Promise<RegistryServer[]> {
  const search = query.trim();
  if (search === "") return [];
  const url = new URL(REGISTRY_SERVERS);
  url.searchParams.set("search", search);
  url.searchParams.set("version", "latest");
  url.searchParams.set("limit", String(boundedLimit(options.limit)));
  const timeout = AbortSignal.timeout(15_000);
  const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]);
  const load = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await load(url, { signal, headers: { accept: "application/json" } });
  } catch (error) {
    if (options.signal?.aborted === true) throw error;
    throw new Error("The registry didn’t answer.");
  }
  if (!response.ok) throw new Error(`The registry didn’t answer (${response.status}).`);
  let body: unknown;
  try {
    body = JSON.parse(await response.text());
  } catch {
    throw new Error("The registry didn’t answer.");
  }
  return serversFromRegistry(body);
}

/** Rows from one registry payload. A row without a name is skipped. */
export function serversFromRegistry(body: unknown): RegistryServer[] {
  const servers = field(body, "servers");
  if (!Array.isArray(servers)) return [];
  const hits: RegistryServer[] = [];
  for (const row of servers) {
    const wrapped = field(row, "server");
    const hit = readServer(wrapped === undefined ? row : wrapped);
    if (hit !== undefined) hits.push(hit);
  }
  return hits;
}

function readServer(server: unknown): RegistryServer | undefined {
  const name = text(field(server, "name"));
  if (name === "") return undefined;
  const description = text(field(server, "description")).replaceAll(/\s+/g, " ");
  return {
    name,
    title: displayTitle(name, text(field(server, "title"))),
    description,
    install: installOf(server),
  };
}

function displayTitle(name: string, title: string): string {
  if (title !== "") return title;
  const slash = name.lastIndexOf("/");
  const leaf = (slash !== -1 ? name.slice(slash + 1) : name).trim();
  return leaf === "" ? name : leaf;
}

function installOf(server: unknown): string {
  const remote = remoteInstall(field(server, "remotes"));
  if (remote !== "") return remote;
  const packages = field(server, "packages");
  if (!Array.isArray(packages)) return "";
  for (const pkg of packages) {
    const command = packageInstall(pkg);
    if (command !== "") return command;
  }
  return "";
}

function remoteInstall(remotes: unknown): string {
  if (!Array.isArray(remotes)) return "";
  let best = "";
  let bestRank = 3;
  for (const remote of remotes) {
    const url = text(field(remote, "url"));
    if (!isHttp(url)) continue;
    const rank = remoteRank(text(field(remote, "type")));
    if (rank < bestRank) {
      best = url;
      bestRank = rank;
    }
  }
  return best;
}

function remoteRank(type: string): number {
  if (type === "streamable-http") return 0;
  if (type === "sse") return 1;
  return 2;
}

function packageInstall(pkg: unknown): string {
  const binary = packageBinary(pkg);
  const identifier = text(field(pkg, "identifier"));
  if (binary === "" || identifier === "" || /\s/.test(identifier)) return "";
  const version = text(field(pkg, "version"));
  const pinned = pin(binary, identifier, version);
  const runtime = argumentTokens(field(pkg, "runtimeArguments"));
  const args = argumentTokens(field(pkg, "packageArguments"));
  if (binary === "docker") {
    const prefix = runtime.length > 0 ? runtime : ["run", "-i", "--rm"];
    return joinCommand("docker", prefix, pinned, args);
  }
  if (binary === "npx") {
    const prefix = runtime.includes("-y") || runtime.includes("--yes") ? runtime : ["-y", ...runtime];
    return joinCommand("npx", prefix, pinned, args);
  }
  return joinCommand(binary, runtime, pinned, args);
}

function packageBinary(pkg: unknown): string {
  const hint = text(field(pkg, "runtimeHint"));
  if (hint === "npx" || hint === "uvx" || hint === "docker" || hint === "dnx") return hint;
  const type = text(field(pkg, "registryType"));
  if (type === "npm") return "npx";
  if (type === "pypi") return "uvx";
  if (type === "oci") return "docker";
  return "";
}

function pin(binary: string, identifier: string, version: string): string {
  if (version === "" || /\s/.test(version) || alreadyPinned(binary, identifier, version)) return identifier;
  if (binary === "docker") return `${identifier}:${version}`;
  return `${identifier}@${version}`;
}

function alreadyPinned(binary: string, identifier: string, version: string): boolean {
  if (binary === "npx" || binary === "uvx" || binary === "dnx") return identifier.endsWith(`@${version}`);
  if (binary === "docker") return identifier.endsWith(`:${version}`);
  return true;
}

function argumentTokens(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const tokens: string[] = [];
  for (const item of value) {
    const raw = text(field(item, "value"));
    if (raw === "" || /\s/.test(raw) || raw.includes("{")) continue;
    if (text(field(item, "type")) === "named") {
      const name = text(field(item, "name"));
      if (name === "" || /\s/.test(name)) continue;
      const flag = name.startsWith("-") ? name : `--${name}`;
      tokens.push(flag, raw);
      continue;
    }
    tokens.push(raw);
  }
  return tokens;
}

function joinCommand(binary: string, prefix: readonly string[], pinned: string, args: readonly string[]): string {
  return [binary, ...prefix, pinned, ...args].join(" ");
}

function boundedLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isInteger(limit)) return 15;
  if (limit < 1) return 1;
  if (limit > 20) return 20;
  return limit;
}

function isHttp(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function field(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  if (!Object.hasOwn(value, key)) return undefined;
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
