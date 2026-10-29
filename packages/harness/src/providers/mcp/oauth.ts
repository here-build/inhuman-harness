/**
 * Spec-compliant MCP HTTP OAuth (401 → PRM → AS → PKCE).
 * Tokens go in secrets.json. Static Authorization and OAuth are exclusive.
 *
 * Same sign-in as completion OIDC adopt: {@link authorizeInBrowser} parks
 * `harness/open-url` and the daemon holds the loopback callback.
 */
import { createHash, randomBytes } from "node:crypto";

import type { ConnectionSecretsView } from "@inhuman.tools/plexus-expectations/driver";
import invariant from "tiny-invariant";

import { authorizeInBrowser } from "@/providers/auth";

import { wrapFetchFailure } from "./fetch.js";
import { asExpiresIn, asNonEmpty, asRecord, asStringArray } from "./json.js";
import { asAdoptString, schemeQuote } from "./quote.js";

export type McpOAuthUi = (body: string) => Promise<Readonly<Record<string, unknown>>>;

export type McpOAuthHost = {
  readonly ui: McpOAuthUi;
  /** The login request's abort: a client cancel while the browser sign-in waits. */
  readonly signal?: AbortSignal;
  writeSecrets(id: string, secrets: Readonly<Record<string, string>>): void;
  readSecrets(id: string): Readonly<Record<string, string>>;
};

/** RFC 8252 portless loopback — DCR only. Authorize URL has no redirect_uri. */
const LOOPBACK_REDIRECT = "http://127.0.0.1/callback";
const AUTH_STATUS_RE = /401|403|unauthorized|forbidden/i;

/** True when the error is HTTP 401/403 and no static bearer is configured. */
export function isMcpAuthChallenge(
  error: unknown,
  secrets: ConnectionSecretsView,
  settings: { readonly headers?: Readonly<Record<string, string>> },
): boolean {
  if (hasStaticBearer(secrets, settings)) return false;
  return looksLikeAuthStatus(error);
}

/** True when a 401/403 carries Protected Resource Metadata — OAuth, not a static token. */
export async function offersMcpOAuth(url: string, signal?: AbortSignal): Promise<boolean> {
  try {
    return parseResourceMetadata(await wwwAuthenticateFromMcp(url, signal)) !== "";
  } catch (error) {
    if (isAbortError(error)) throw error;
    return false;
  }
}

/**
 * Authorization-code + PKCE through {@link authorizeInBrowser}.
 * Pasted text that is not a redirect URL is a static token (OpenRouter dual path).
 */
export async function collectMcpHttpOAuth(
  url: string,
  ui: McpOAuthUi,
  stored: Readonly<Record<string, string>> = {},
  signal?: AbortSignal,
): Promise<Record<string, string>> {
  const resourceMetadataUrl = await resourceMetadataUrlFromMcp(url, signal);
  const resourceMeta = asRecord(await fetchJson(resourceMetadataUrl, undefined, signal));
  const authorizationServers = asStringArray(resourceMeta?.authorization_servers);
  const issuer = authorizationServers[0];
  invariant(issuer !== undefined, "mcp oauth: protected resource metadata has no authorization_servers");
  const asMeta = asRecord(await fetchJson(authorizationServerMetadataUrl(issuer), undefined, signal));
  const authorizationEndpoint = asNonEmpty(asMeta?.authorization_endpoint);
  const tokenEndpoint = asNonEmpty(asMeta?.token_endpoint);
  invariant(
    authorizationEndpoint !== undefined,
    "mcp oauth: authorization server metadata missing authorization_endpoint",
  );
  invariant(tokenEndpoint !== undefined, "mcp oauth: authorization server metadata missing token_endpoint");
  const storedClientId = asNonEmpty(stored.client_id);
  const storedClientSecret = asNonEmpty(stored.client_secret);
  const registrationEndpoint = asNonEmpty(asMeta?.registration_endpoint);
  let clientId =
    storedClientId ??
    (registrationEndpoint === undefined ? "" : await registerPublicClient(registrationEndpoint, signal));
  let clientSecret = storedClientSecret ?? "";
  if (clientId === "") {
    const registered = await resolveRegisteredClient(ui, asMeta);
    clientId = registered.clientId;
    clientSecret = registered.clientSecret;
  }
  invariant(
    clientId !== "",
    "mcp oauth: client_id is required — this authorization server has no dynamic registration",
  );

  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(16).toString("base64url");
  const authorize = new URL(authorizationEndpoint);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set("code_challenge", challenge);
  authorize.searchParams.set("code_challenge_method", "S256");
  authorize.searchParams.set("state", state);
  const scopes = asStringArray(resourceMeta?.scopes_supported);
  if (scopes.length > 0) authorize.searchParams.set("scope", scopes.join(" "));
  try {
    authorize.searchParams.set("resource", new URL(url).toString());
  } catch {
    /* RFC 8707 resource is optional when the MCP URL is not absolute */
  }

  const authorized = await authorizeInBrowser(ui, {
    authUrl: authorize.toString(),
    description: "Authorize MCP in the browser",
    paste: "Or paste a token, or the address the browser ended on",
    signal,
  });
  if ("pasted" in authorized) return { token: authorized.pasted };
  const { code, redirectUri } = authorized;
  // Strict on a real callback: we always send state, so an absent param is a mismatch.
  invariant(authorized.state === state, "mcp oauth: sign-in state mismatch");

  const tokenBody = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
  tokenBody.set("client_id", clientId);
  if (clientSecret !== "") tokenBody.set("client_secret", clientSecret);
  const tokens = asRecord(
    await fetchJson(
      tokenEndpoint,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: tokenBody,
      },
      signal,
    ),
  );
  const accessToken = asNonEmpty(tokens?.access_token);
  if (accessToken === undefined) throw new Error("mcp oauth: token exchange returned no access_token");
  const expiresIn = asExpiresIn(tokens?.expires_in);
  const expiresAt = expiresIn === undefined ? "" : String(Math.floor(Date.now() / 1000) + expiresIn);
  return {
    token: accessToken,
    refresh_token: asNonEmpty(tokens?.refresh_token) ?? "",
    token_type: asNonEmpty(tokens?.token_type) ?? "Bearer",
    expires_at: expiresAt,
    token_endpoint: tokenEndpoint,
    client_id: clientId,
    ...(clientSecret === "" ? {} : { client_secret: clientSecret }),
  };
}

/** Refresh grant on this MCP row. Never a Grok/ChatGPT token. */
export async function refreshMcpHttpToken(stored: Readonly<Record<string, string>>): Promise<Record<string, string>> {
  const refreshToken = asNonEmpty(stored.refresh_token);
  const tokenEndpoint = asNonEmpty(stored.token_endpoint);
  const clientId = asNonEmpty(stored.client_id);
  invariant(refreshToken !== undefined, "mcp oauth: no refresh_token");
  invariant(tokenEndpoint !== undefined, "mcp oauth: no token_endpoint");
  invariant(clientId !== undefined, "mcp oauth: no client_id");
  const tokenBody = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
  });
  const clientSecret = asNonEmpty(stored.client_secret);
  if (clientSecret !== undefined) tokenBody.set("client_secret", clientSecret);
  const tokens = asRecord(
    await fetchJson(tokenEndpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: tokenBody,
    }),
  );
  const accessToken = asNonEmpty(tokens?.access_token);
  if (accessToken === undefined) throw new Error("mcp oauth: refresh returned no access_token");
  const expiresIn = asExpiresIn(tokens?.expires_in);
  const expiresAt =
    expiresIn === undefined ? (stored.expires_at ?? "") : String(Math.floor(Date.now() / 1000) + expiresIn);
  return {
    ...Object.fromEntries(Object.entries(stored).filter(([, value]) => value !== "")),
    token: accessToken,
    refresh_token: asNonEmpty(tokens?.refresh_token) ?? refreshToken,
    token_type: asNonEmpty(tokens?.token_type) ?? stored.token_type ?? "Bearer",
    expires_at: expiresAt,
    token_endpoint: tokenEndpoint,
    client_id: clientId,
    ...(clientSecret === undefined ? {} : { client_secret: clientSecret }),
  };
}

export async function loginMcpHttp(id: string, url: string, host: McpOAuthHost): Promise<void> {
  host.writeSecrets(id, await collectMcpHttpOAuth(url, host.ui, host.readSecrets(id), host.signal));
}

export function logoutMcpHttp(id: string, host: Pick<McpOAuthHost, "writeSecrets">): void {
  host.writeSecrets(id, {});
}

function hasStaticBearer(
  secrets: ConnectionSecretsView,
  settings: { readonly headers?: Readonly<Record<string, string>> },
): boolean {
  const token = secrets.get("token");
  const apiKey = secrets.get("apiKey");
  const header = settings.headers?.Authorization;
  return (
    (typeof token === "string" && token !== "") ||
    (typeof apiKey === "string" && apiKey !== "") ||
    (typeof header === "string" && header !== "")
  );
}

function looksLikeAuthStatus(error: unknown): boolean {
  let current: unknown = error;
  for (let i = 0; i < 4 && current != null; i++) {
    if (typeof current === "string") return AUTH_STATUS_RE.test(current);
    if (typeof current === "object") {
      const rec = current as {
        status?: unknown;
        code?: unknown;
        message?: unknown;
        cause?: unknown;
      };
      if (isUnauthorizedCode(rec.status) || isUnauthorizedCode(rec.code)) return true;
      if (typeof rec.message === "string" && AUTH_STATUS_RE.test(rec.message)) return true;
      current = rec.cause;
      continue;
    }
    return false;
  }
  return false;
}

function isUnauthorizedCode(value: unknown): boolean {
  return value === 401 || value === 403 || value === "401" || value === "403";
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function throwFetch(error: unknown, opts: { url: string; method: string }): never {
  if (isAbortError(error)) throw error;
  throw wrapFetchFailure(error, { why: "mcp oauth", method: opts.method, url: opts.url });
}

async function resourceMetadataUrlFromMcp(url: string, signal?: AbortSignal): Promise<string> {
  const header = await wwwAuthenticateFromMcp(url, signal);
  const metadata = parseResourceMetadata(header);
  if (metadata === "") throw new Error("mcp oauth: WWW-Authenticate missing resource_metadata");
  try {
    return new URL(metadata, url).toString();
  } catch {
    return metadata;
  }
}

async function wwwAuthenticateFromMcp(url: string, signal?: AbortSignal): Promise<string> {
  let post: Response;
  try {
    post = await fetch(url, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: "{}",
      signal,
    });
  } catch (error) {
    throwFetch(error, { method: "POST", url });
  }
  await post.arrayBuffer().catch(() => undefined);
  if (post.status === 401 || post.status === 403) {
    return post.headers.get("www-authenticate") ?? "";
  }
  let get: Response;
  try {
    get = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal,
    });
  } catch (error) {
    throwFetch(error, { method: "GET", url });
  }
  await get.arrayBuffer().catch(() => undefined);
  if (get.status === 401 || get.status === 403) {
    return get.headers.get("www-authenticate") ?? "";
  }
  throw new Error(`mcp oauth: expected 401 from ${url}, got ${post.status}`);
}

function parseResourceMetadata(header: string): string {
  const match = header.match(/resource_metadata=(?:"([^"]+)"|([^\s,]+))/i);
  return (match?.[1] ?? match?.[2] ?? "").trim();
}

function authorizationServerMetadataUrl(issuer: string): string {
  const parsed = new URL(issuer);
  const path = parsed.pathname.replace(/\/+$/, "");
  parsed.pathname = `/.well-known/oauth-authorization-server${path}`;
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

async function resolveRegisteredClient(
  ui: McpOAuthUi,
  asMeta: Record<string, unknown> | null,
): Promise<{ clientId: string; clientSecret: string }> {
  const docs = asNonEmpty(asMeta?.service_documentation);
  const description =
    "This authorization server has no dynamic registration. Create an OAuth or GitHub App with callback http://127.0.0.1/callback, then paste the client ID.";
  const idInput = `(harness/input :name "OAuth client ID" :description ${schemeQuote(description)})`;
  let idAnswer = await ui(
    docs === undefined
      ? idInput
      : `(harness/open-url :url ${schemeQuote(docs)} :name "OAuth client ID" :description ${schemeQuote(description)} :input 'text)`,
  );
  // An empty field on the docs park opens the link (`opened`); the client ID is still owed.
  if (idAnswer.kind === "opened") idAnswer = await ui(idInput);
  const clientId = asAdoptString(idAnswer.input);
  invariant(
    clientId !== "",
    "mcp oauth: client_id is required — this authorization server has no dynamic registration",
  );
  const secretAnswer = await ui(
    `(harness/input :name "OAuth client secret" :description ${schemeQuote("Optional. GitHub OAuth Apps need this to exchange the code.")} :secret #t)`,
  );
  return { clientId, clientSecret: asAdoptString(secretAnswer.input) };
}

async function registerPublicClient(registrationEndpoint: string, signal?: AbortSignal): Promise<string> {
  const rec = asRecord(
    await fetchJson(
      registrationEndpoint,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          client_name: "Harness",
          redirect_uris: [LOOPBACK_REDIRECT],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        }),
      },
      signal,
    ),
  );
  const clientId = asNonEmpty(rec?.client_id);
  if (clientId === undefined) throw new Error("mcp oauth: dynamic client registration returned no client_id");
  return clientId;
}

async function fetchJson(url: string, init?: RequestInit, signal?: AbortSignal): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, signal == null ? init : { ...init, signal });
  } catch (error) {
    throwFetch(error, {
      method: typeof init?.method === "string" && init.method.trim() !== "" ? init.method : "GET",
      url,
    });
  }
  const text = await response.text().catch(() => "");
  invariant(response.ok, `mcp oauth: ${response.status} ${url}${text === "" ? "" : `: ${text}`}`);
  if (text === "") return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`mcp oauth: invalid JSON from ${url}`);
  }
}
