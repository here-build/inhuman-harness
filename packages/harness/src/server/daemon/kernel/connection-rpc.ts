/**
 * Kernel-plane ConnectionSpec RPC helpers.
 * List is generic expectation rows; optional `abilityClaim` filters DriverSpec.abilityClaim.
 * Secrets never appear in list/get.
 */
import { type ConnectionListRow, type ConnectionStatus } from "@inhuman.tools/harness-contract";
import type { ConnectionSpec } from "@inhuman.tools/expectations";

import { loginMcpHttp, type McpOAuthHost, filterMcpToolNames, mcpToolsSettingOf } from "@/providers/mcp";

import { RpcInvalidParams } from "../../contract.js";
import { readField } from "../../util/read-field.js";

export function settingsBag(spec: ConnectionSpec): Record<string, unknown> {
  const settings: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(spec.configuration)) {
    if (key === "secrets") continue;
    settings[key] = value;
  }
  return settings;
}

export function toListRow(id: string, spec: ConnectionSpec): ConnectionListRow {
  const settings = settingsBag(spec);
  const live = spec.live;
  const enabled = settings.enabled !== false;
  let status: ConnectionStatus = "idle";
  if (!enabled) status = "disabled";
  else if (live.auth === "needs-auth") status = "needs-auth";
  else if (spec.readyState === "failed" || spec.issue === "failed") status = "failed";
  else if (spec.readyState === "bootstrapping") status = "connecting";
  else if (spec.readyState === "ready") status = "ready";
  return {
    id,
    name: spec.name,
    driver: spec.driver.name,
    abilityClaim: [...spec.driver.abilityClaim],
    enabled,
    status,
    toolCount: Array.isArray(live.tools)
      ? filterMcpToolNames(
          live.tools
            .map((row) =>
              row !== null && typeof row === "object" && "serverToolName" in row
                ? String(readField(row, "serverToolName") ?? "")
                : "",
            )
            .filter((name) => name !== ""),
          mcpToolsSettingOf(settings),
        ).length
      : 0,
    error: spec.error,
  };
}

export function requireConnection(
  connections: Record<string, ConnectionSpec>,
  id: string,
  method: string,
): ConnectionSpec {
  const spec = connections[id];
  RpcInvalidParams.invariant(spec !== undefined, `${method}: unknown connection ${id}`);
  return spec;
}

function authorizationHeader(settings: Readonly<Record<string, unknown>>): string {
  const headers = settings.headers;
  if (typeof headers !== "object" || headers === null || Array.isArray(headers)) return "";
  const value = readField(headers, "Authorization");
  return typeof value === "string" ? value.trim() : "";
}

export function hasStaticToken(
  secrets: Readonly<Record<string, string>>,
  settings: Readonly<Record<string, unknown>>,
): boolean {
  const token = secrets.token ?? "";
  const apiKey = secrets.apiKey ?? "";
  return token !== "" || apiKey !== "" || authorizationHeader(settings) !== "";
}

export async function loginConnection(
  id: string,
  connections: Record<string, ConnectionSpec>,
  host: McpOAuthHost,
): Promise<{ ok: true }> {
  const spec = requireConnection(connections, id, "connect/login");
  RpcInvalidParams.invariant(
    spec.driver.name === "mcp-http" || spec.driver.importPath === "mcp-http",
    `connect/login: not mcp-http (${spec.driver.name})`,
  );
  const settings = settingsBag(spec);
  const url = typeof settings.url === "string" ? settings.url.trim() : "";
  RpcInvalidParams.invariant(url !== "", "connect/login: url is required");
  RpcInvalidParams.invariant(
    !hasStaticToken(host.readSecrets(id), settings),
    "static token; logout/remove it to use OAuth",
  );
  await loginMcpHttp(id, url, host);
  return { ok: true };
}

/** What a new or stored connection looks like to the duplicate check. */
export type ConnectionFingerprintSource = {
  readonly driver: string;
  readonly settings: Readonly<Record<string, unknown>>;
  readonly secrets: Readonly<Record<string, string>>;
};

/** OIDC sign-ins carry a refresh token: one endpoint may host several accounts. */
function signedInByOidc(secrets: Readonly<Record<string, string>>): boolean {
  return (secrets.refreshToken ?? "") !== "";
}

function endpointOf(row: ConnectionFingerprintSource): string {
  const settings = row.settings;
  for (const key of ["url", "baseUrl", "baseURL", "endpoint"]) {
    const value = settings[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim().replace(/\/+$/, "").toLowerCase();
  }
  if (typeof settings.command === "string" && settings.command.trim() !== "") {
    const args = Array.isArray(settings.args) ? settings.args.map(String) : [];
    return [settings.command.trim(), ...args].join(" ");
  }
  return "";
}

function staticTokenOf(row: ConnectionFingerprintSource): string {
  const token = row.secrets.token ?? "";
  if (token !== "") return token;
  const apiKey = row.secrets.apiKey ?? "";
  if (apiKey !== "") return apiKey;
  return authorizationHeader(row.settings);
}

/**
 * The id of a stored connection the candidate would duplicate: same driver,
 * same endpoint, same static token (two empty tokens match). OIDC sign-ins on
 * either side never collide.
 */
export function duplicateConnectionOf(
  candidate: ConnectionFingerprintSource,
  stored: Readonly<Record<string, ConnectionFingerprintSource>>,
): string | null {
  if (signedInByOidc(candidate.secrets)) return null;
  const endpoint = endpointOf(candidate);
  const token = staticTokenOf(candidate);
  for (const [id, row] of Object.entries(stored)) {
    if (id.startsWith("__") || row.driver !== candidate.driver || signedInByOidc(row.secrets)) continue;
    if (endpointOf(row) === endpoint && staticTokenOf(row) === token) return id;
  }
  return null;
}
