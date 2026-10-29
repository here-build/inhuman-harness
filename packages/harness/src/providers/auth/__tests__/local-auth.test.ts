/**
 * PKCE, code exchange, refresh, userinfo, and device-code against a real
 * local authorization server. No vendor providers, no OpenAI connection.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import {
  accessTokenExpiring,
  DEVICE_CODE_GRANT,
  exchangeOidcCode,
  fetchOidcUserinfo,
  identityFromClaims,
  jwtPayload,
  mergeOidcIdentity,
  mintOidcPkce,
  OIDC_REFRESH_SKEW_MS,
  pkceChallenge,
  pollDeviceToken,
  refreshOidcToken,
  requestDeviceCode,
  secretsFromTokens,
  type DeviceClient,
  type OidcProfile,
} from "../index.js";

const REDIRECT = "http://127.0.0.1/callback";

type AuthMode = "ok" | "deny-device" | "expire-device";

type OwnedAuth = {
  readonly origin: string;
  readonly profile: OidcProfile;
  readonly device: DeviceClient;
  close(): Promise<void>;
};

function unsignedJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.`;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json",
    connection: "close",
  });
  res.end(JSON.stringify(body));
}

function send(res: ServerResponse, status: number, headers: Record<string, string>, body: string): void {
  res.writeHead(status, { connection: "close", ...headers });
  res.end(body);
}

async function startOwnedAuth(mode: AuthMode = "ok"): Promise<OwnedAuth> {
  const codes = new Map<string, { challenge: string }>();
  const refresh = new Map<string, { n: number }>();
  const devices = new Map<string, { polls: number }>();
  let issued = 0;

  const httpServer: Server = createServer((req, res) => {
    void (async () => {
      const origin = `http://127.0.0.1:${(httpServer.address() as { port: number }).port}`;
      const url = new URL(req.url ?? "/", origin);
      const pathname = url.pathname.replace(/\/+$/, "") || "/";

      if (pathname === "/authorize") {
        const code = randomBytes(16).toString("base64url");
        codes.set(code, {
          challenge: url.searchParams.get("code_challenge") ?? "",
        });
        const redirect = new URL(url.searchParams.get("redirect_uri") ?? REDIRECT);
        redirect.searchParams.set("code", code);
        redirect.searchParams.set("state", url.searchParams.get("state") ?? "");
        send(res, 302, { location: redirect.toString() }, "");
        return;
      }

      if (pathname === "/device/code") {
        const params = new URLSearchParams(await readBody(req));
        const deviceCode = randomBytes(16).toString("base64url");
        const userCode = "ABCD-EFGH";
        devices.set(deviceCode, { polls: 0 });
        sendJson(res, 200, {
          device_code: deviceCode,
          user_code: userCode,
          verification_uri: `${origin}/device`,
          expires_in: 600,
          interval: 0,
          client_id: params.get("client_id"),
          scope: params.get("scope"),
        });
        return;
      }

      if (pathname === "/token") {
        const params = new URLSearchParams(await readBody(req));
        const grant = params.get("grant_type");
        if (grant === "authorization_code") {
          const stored = codes.get(params.get("code") ?? "");
          const verifier = params.get("code_verifier") ?? "";
          const challenge = createHash("sha256").update(verifier).digest("base64url");
          if (stored?.challenge !== challenge) {
            sendJson(res, 400, { error: "invalid_grant" });
            return;
          }
          codes.delete(params.get("code") ?? "");
          issued += 1;
          const refreshToken = `rt-${issued}`;
          refresh.set(refreshToken, { n: issued });
          sendJson(res, 200, {
            access_token: `at-${issued}`,
            refresh_token: refreshToken,
            token_type: "Bearer",
            expires_in: 3600,
            id_token: unsignedJwt({
              email: "user@local.test",
              name: "Local User",
              user_id: "acct-1",
              plan: "pro",
            }),
          });
          return;
        }
        if (grant === "refresh_token") {
          const stored = refresh.get(params.get("refresh_token") ?? "");
          if (stored === undefined) {
            sendJson(res, 400, { error: "invalid_grant" });
            return;
          }
          issued += 1;
          const nextRefresh = `rt-${issued}`;
          refresh.delete(params.get("refresh_token") ?? "");
          refresh.set(nextRefresh, { n: issued });
          sendJson(res, 200, {
            access_token: `at-${issued}`,
            refresh_token: nextRefresh,
            token_type: "Bearer",
            expires_in: 3600,
          });
          return;
        }
        if (grant === DEVICE_CODE_GRANT) {
          const row = devices.get(params.get("device_code") ?? "");
          if (row === undefined) {
            sendJson(res, 400, { error: "invalid_grant" });
            return;
          }
          row.polls += 1;
          if (mode === "deny-device") {
            sendJson(res, 400, { error: "access_denied" });
            return;
          }
          if (mode === "expire-device") {
            sendJson(res, 400, { error: "expired_token" });
            return;
          }
          if (row.polls === 1) {
            sendJson(res, 400, { error: "authorization_pending" });
            return;
          }
          issued += 1;
          const refreshToken = `rt-${issued}`;
          refresh.set(refreshToken, { n: issued });
          sendJson(res, 200, {
            access_token: `at-${issued}`,
            refresh_token: refreshToken,
            token_type: "Bearer",
            expires_in: 3600,
          });
          return;
        }
        sendJson(res, 400, { error: "unsupported_grant_type" });
        return;
      }

      if (pathname === "/userinfo") {
        const header = req.headers.authorization ?? "";
        if (!header.startsWith("Bearer at-")) {
          sendJson(res, 401, { error: "invalid_token" });
          return;
        }
        sendJson(res, 200, {
          email: "user@local.test",
          name: "Local User",
          account_id: "acct-1",
          plan: "pro",
        });
        return;
      }

      sendJson(res, 404, { error: "not_found" });
    })().catch(() => {
      if (!res.headersSent) send(res, 500, {}, "");
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.listen(0, "127.0.0.1", () => resolve());
    httpServer.once("error", reject);
  });
  const origin = `http://127.0.0.1:${(httpServer.address() as { port: number }).port}`;
  return {
    origin,
    profile: {
      driver: "local-auth",
      clientId: "harness-auth-test",
      authorizeUrl: `${origin}/authorize`,
      tokenUrl: `${origin}/token`,
      userinfoUrl: `${origin}/userinfo`,
      scope: "openid profile email offline_access",
      extraAuthorize: { audience: "local" },
      loginHint: "Authorize the local test issuer",
      baseUrl: `${origin}/v1`,
    },
    device: {
      driver: "local-auth",
      label: "Local Auth",
      clientId: "harness-auth-test",
      deviceCodeUrl: `${origin}/device/code`,
      tokenUrl: `${origin}/token`,
      scope: "openid profile email offline_access",
      extraDevice: { source: "device_code" },
      fallbackVerificationUri: `${origin}/device`,
      minIntervalSec: 0,
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

const servers: OwnedAuth[] = [];

afterEach(async () => {
  const closing = servers.splice(0);
  await Promise.all(closing.map((server) => server.close()));
});

async function owned(mode: AuthMode = "ok"): Promise<OwnedAuth> {
  const server = await startOwnedAuth(mode);
  servers.push(server);
  return server;
}

describe("local auth endpoint", () => {
  it("exchanges authorization-code + PKCE, refreshes, and reads userinfo", async () => {
    const server = await owned();
    const pkce = mintOidcPkce(server.profile);
    expect(pkce.challenge).toBe(pkceChallenge(pkce.verifier));
    expect(pkce.url).toContain("code_challenge_method=S256");
    expect(pkce.url).toContain("audience=local");

    const authorize = new URL(pkce.url);
    authorize.searchParams.set("redirect_uri", REDIRECT);
    const redirected = await fetch(authorize, { redirect: "manual" });
    expect(redirected.status).toBe(302);
    const location = redirected.headers.get("location");
    if (location === null) throw new Error("authorize returned no location");
    const callback = new URL(location);
    expect(callback.searchParams.get("state")).toBe(pkce.state);
    const code = callback.searchParams.get("code") ?? "";

    const tokens = await exchangeOidcCode(server.profile, code, pkce.verifier, REDIRECT);
    expect(tokens.apiKey).toMatch(/^at-/);
    expect(tokens.refreshToken).toMatch(/^rt-/);
    expect(tokens.email).toBe("user@local.test");
    expect(tokens.displayName).toBe("Local User");
    expect(tokens.accountId).toBe("acct-1");
    expect(tokens.plan).toBe("pro");
    expect(secretsFromTokens(tokens).apiKey).toBe(tokens.apiKey);

    const refreshed = await refreshOidcToken(server.profile, tokens.refreshToken);
    expect(refreshed.apiKey).not.toBe(tokens.apiKey);
    expect(refreshed.refreshToken).not.toBe(tokens.refreshToken);

    const userinfo = await fetchOidcUserinfo(server.profile, refreshed.apiKey);
    expect(userinfo).toEqual({
      accountId: "acct-1",
      displayName: "Local User",
      email: "user@local.test",
      plan: "pro",
    });
  });

  it("rejects a PKCE verifier that does not match the challenge", async () => {
    const server = await owned();
    const pkce = mintOidcPkce(server.profile);
    const authorize = new URL(pkce.url);
    authorize.searchParams.set("redirect_uri", REDIRECT);
    const redirected = await fetch(authorize, { redirect: "manual" });
    const location = redirected.headers.get("location");
    if (location === null) throw new Error("authorize returned no location");
    const code = new URL(location).searchParams.get("code") ?? "";
    await expect(exchangeOidcCode(server.profile, code, "wrong-verifier", REDIRECT)).rejects.toThrow(
      /token exchange failed \(400\)/,
    );
  });

  it("polls device-code through authorization_pending then stores tokens", async () => {
    const server = await owned();
    const device = await requestDeviceCode(server.device);
    expect(device.userCode).toBe("ABCD-EFGH");
    expect(device.verificationUriComplete).toContain("user_code=ABCD-EFGH");
    const tokens = await pollDeviceToken(server.device, device, {
      now: () => Date.now(),
      wait: async () => {},
    });
    expect(tokens.apiKey).toMatch(/^at-/);
    expect(tokens.refreshToken).toMatch(/^rt-/);
  });

  it("stops polling the moment its signal aborts", async () => {
    const server = await owned();
    const device = await requestDeviceCode(server.device);
    const abort = new AbortController();
    const polling = pollDeviceToken(
      server.device,
      { ...device, expiresInSec: 600 },
      { now: () => Date.now(), wait: () => new Promise<void>(() => undefined) },
      abort.signal,
    );
    setTimeout(() => abort.abort(), 20);
    await expect(polling).rejects.toMatchObject({ name: "AbortError" });
  });

  it("maps device access_denied and expired_token", async () => {
    const denied = await owned("deny-device");
    const deniedDevice = await requestDeviceCode(denied.device);
    await expect(
      pollDeviceToken(denied.device, deniedDevice, {
        now: () => Date.now(),
        wait: async () => {},
      }),
    ).rejects.toThrow(/authorization denied/);

    const expired = await owned("expire-device");
    const expiredDevice = await requestDeviceCode(expired.device);
    await expect(
      pollDeviceToken(expired.device, expiredDevice, {
        now: () => Date.now(),
        wait: async () => {},
      }),
    ).rejects.toThrow(/device code expired/);
  });
});

describe("token bundle helpers", () => {
  it("treats skew as expiring", () => {
    const now = 1_700_000_000_000;
    const soon = new Date(now + 60_000).toISOString();
    const later = new Date(now + OIDC_REFRESH_SKEW_MS + 1).toISOString();
    expect(accessTokenExpiring(soon, now)).toBe(true);
    expect(accessTokenExpiring(later, now)).toBe(false);
    expect(accessTokenExpiring(undefined, now)).toBe(false);
  });

  it("reads identity from JWT claims and later non-empty fields win", () => {
    const token = unsignedJwt({
      email: "a@example.test",
      given_name: "Ada",
      family_name: "Lovelace",
      userId: "u-1",
    });
    expect(identityFromClaims(jwtPayload(token))).toEqual({
      accountId: "u-1",
      displayName: "Ada Lovelace",
      email: "a@example.test",
    });
    expect(mergeOidcIdentity({ email: "old@example.test", plan: "free" }, { email: "new@example.test" })).toEqual({
      email: "new@example.test",
      plan: "free",
    });
  });
});
