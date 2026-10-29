/**
 * MCP adopt: parse a dropped http(s) URL or stdio command.
 * HTTP remainder that 401s with Protected Resource Metadata parks the same
 * PKCE `harness/open-url` as connect/login. Otherwise an optional token.
 */
import invariant from "tiny-invariant";

import { collectMcpHttpOAuth, offersMcpOAuth } from "./oauth.js";
import { asAdoptString } from "./quote.js";

export type AdoptCallback = (kind: "UI", body: string) => Promise<Readonly<Record<string, unknown>>>;

export type DriverAdoptBags = {
  readonly name?: string;
  readonly settings: Record<string, unknown>;
  readonly secrets: Record<string, string>;
};

export type McpAdoptArgs = {
  name?: string;
  settings?: Record<string, unknown>;
  input?: string;
  signal?: AbortSignal;
};

export type McpAdoptBags = DriverAdoptBags & {
  readonly driver: "mcp-http" | "mcp-stdio";
};

export function isHttpMcpEndpoint(input: string): boolean {
  try {
    const url = new URL(input.trim());
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function parseMcpEndpoint(input: string): {
  readonly driver: "mcp-http" | "mcp-stdio";
  readonly settings: Record<string, unknown>;
} {
  const trimmed = input.trim();
  if (isHttpMcpEndpoint(trimmed)) {
    return { driver: "mcp-http", settings: { url: trimmed } };
  }
  const parts = trimmed.split(/\s+/).filter((part) => part !== "");
  const command = parts[0];
  invariant(command !== undefined, "mcp adopt: URL or command is required");
  return {
    driver: "mcp-stdio",
    settings: {
      command,
      ...(parts.length > 1 ? { args: parts.slice(1) } : {}),
    },
  };
}

function nameFromHttp(url: string): string {
  try {
    const host = new URL(url).hostname;
    if (host.startsWith("mcp.") && host.slice(4).includes(".")) return host.slice(4);
    return host === "" ? "mcp-http" : host;
  } catch {
    return "mcp-http";
  }
}

function nameFromCommand(command: string): string {
  const base = command.split(/[/\\]/).pop() ?? command;
  const stem = base.replace(/\.(js|mjs|cjs|exe)$/i, "");
  return stem === "" ? "mcp-stdio" : stem;
}

export async function adoptMcp(args: McpAdoptArgs, callback: AdoptCallback): Promise<McpAdoptBags> {
  const settings = { ...(args.settings ?? {}) };
  const signal = args.signal;
  const fromSettings = asAdoptString(settings.url) !== "" || asAdoptString(settings.command) !== "";
  let endpoint = asAdoptString(args.input);
  if (!fromSettings && endpoint === "") {
    const { input } = await callback(
      "UI",
      '(harness/input :name "MCP URL or command" :description "https://… or a stdio command")',
    );
    endpoint = asAdoptString(input);
  }
  throwIfAborted(signal);
  const parsed = fromSettings
    ? asAdoptString(settings.url) === ""
      ? { driver: "mcp-stdio" as const, settings }
      : { driver: "mcp-http" as const, settings }
    : parseMcpEndpoint(endpoint);
  const nextSettings = fromSettings ? settings : { ...settings, ...parsed.settings };
  const driver = parsed.driver;
  const secrets: Record<string, string> = {};
  if (driver === "mcp-http" && !fromSettings) {
    const mcpUrl = asAdoptString(nextSettings.url);
    if (await offersMcpOAuth(mcpUrl, signal)) {
      throwIfAborted(signal);
      Object.assign(secrets, await collectMcpHttpOAuth(mcpUrl, (body) => callback("UI", body), {}, signal));
    } else {
      throwIfAborted(signal);
      const { input: token } = await callback(
        "UI",
        '(harness/input :name "Token" :description "Optional. Empty to skip; Authenticate later for OAuth." :secret #t)',
      );
      const key = asAdoptString(token);
      if (key !== "") secrets.token = key;
    }
  }
  throwIfAborted(signal);
  const given = (args.name ?? "").trim();
  const generic = given.toLowerCase();
  const name =
    generic === "" || generic === "add mcp" || generic === "mcp" || generic === "mcp-http" || generic === "mcp-stdio"
      ? driver === "mcp-http"
        ? nameFromHttp(asAdoptString(nextSettings.url))
        : nameFromCommand(asAdoptString(nextSettings.command))
      : given;
  return { driver, name, settings: nextSettings, secrets };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  const reason = signal.reason;
  if (reason instanceof Error) throw reason;
  throw new DOMException("aborted", "AbortError");
}
