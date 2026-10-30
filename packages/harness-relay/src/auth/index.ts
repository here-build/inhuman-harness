import type { JWTVerifyGetKey } from "jose";

import { isAllowedEmail } from "../allowlist.js";
import { userStub } from "../stubs.js";
import { clearCookie, getCookie, setCookie } from "./cookies.js";
import { DEV_COOKIE, parseDevCredential } from "./dev.js";
import { verifyAccessToken } from "./jwt.js";
import { seal, unseal } from "./seal.js";
import { fetchUser, refreshTokens } from "./workos.js";

export const SESSION_COOKIE = "relay_session";

export interface AuthDeps {
  jwks?: JWTVerifyGetKey;
  fetch?: typeof fetch;
}

export type AuthResult =
  { ok: true; sub: string; email?: string; setCookie?: string } | { ok: false; status: 401 | 403 };

interface Session {
  accessToken: string;
  refreshToken: string;
}

export function sealSession(env: Env, session: Session): Promise<string> {
  return seal(session, env.WORKOS_COOKIE_PASSWORD);
}

/**
 * Allowlist check, with the verdict cached in UserDO. With an email at hand (login, dev gate) it is
 * recorded; without one (daemon bearer for an unknown sub) the user is fetched from WorkOS once.
 */
export async function checkAllowed(env: Env, sub: string, email?: string, deps: AuthDeps = {}): Promise<boolean> {
  const stub = userStub(env, sub);
  if (email) {
    const allowed = isAllowedEmail(email, env.ALLOWED_EMAILS);
    const known = await stub.getProfile();
    if (known?.email !== email || known.allowed !== allowed) await stub.setProfile(email, allowed);
    return allowed;
  }
  const known = await stub.getProfile();
  if (known) return isAllowedEmail(known.email, env.ALLOWED_EMAILS);
  const user = await fetchUser(env, sub, deps.fetch);
  if (!user) return false;
  const allowed = isAllowedEmail(user.email, env.ALLOWED_EMAILS);
  await stub.setProfile(user.email, allowed);
  return allowed;
}

/** `Authorization: Bearer <WorkOS access token>`, or the dev credential when the dev gate is on. */
export async function authenticateDaemon(req: Request, env: Env, deps: AuthDeps = {}): Promise<AuthResult> {
  const m = /^Bearer (.+)$/i.exec(req.headers.get("authorization") ?? "");
  if (!m) return { ok: false, status: 401 };
  const token = m[1]!;
  const dev = parseDevCredential(token, env.DEV_AUTH_TOKEN);
  if (dev) {
    return (await checkAllowed(env, dev.sub, dev.email, deps))
      ? { ok: true, sub: dev.sub, email: dev.email }
      : { ok: false, status: 403 };
  }
  const verified = await verifyAccessToken(token, env.WORKOS_CLIENT_ID, deps.jwks);
  if (!verified.ok) return { ok: false, status: 401 };
  return (await checkAllowed(env, verified.sub, undefined, deps))
    ? { ok: true, sub: verified.sub }
    : { ok: false, status: 403 };
}

/** Sealed session cookie; refreshes an expired access token and hands back the new cookie. */
export async function authenticateBrowser(req: Request, env: Env, deps: AuthDeps = {}): Promise<AuthResult> {
  const devCookie = getCookie(req, DEV_COOKIE);
  if (devCookie) {
    const dev = parseDevCredential(decodeURIComponent(devCookie), env.DEV_AUTH_TOKEN);
    if (dev) {
      return (await checkAllowed(env, dev.sub, dev.email, deps))
        ? { ok: true, sub: dev.sub, email: dev.email }
        : { ok: false, status: 403 };
    }
  }
  const raw = getCookie(req, SESSION_COOKIE);
  if (!raw || !env.WORKOS_COOKIE_PASSWORD) return { ok: false, status: 401 };
  const session = await unseal<Session>(raw, env.WORKOS_COOKIE_PASSWORD);
  if (!session) return { ok: false, status: 401 };

  let verified = await verifyAccessToken(session.accessToken, env.WORKOS_CLIENT_ID, deps.jwks);
  let renewed: string | undefined;
  let email: string | undefined;
  if (!verified.ok) {
    if (!verified.expired) return { ok: false, status: 401 };
    const fresh = await refreshTokens(env, session.refreshToken, deps.fetch);
    if (!fresh) return { ok: false, status: 401 };
    verified = await verifyAccessToken(fresh.accessToken, env.WORKOS_CLIENT_ID, deps.jwks);
    if (!verified.ok) return { ok: false, status: 401 };
    email = fresh.user.email;
    renewed = setCookie(
      new URL(req.url),
      SESSION_COOKIE,
      await sealSession(env, { accessToken: fresh.accessToken, refreshToken: fresh.refreshToken }),
    );
  }
  if (!(await checkAllowed(env, verified.sub, email, deps))) return { ok: false, status: 403 };
  return { ok: true, sub: verified.sub, ...(email ? { email } : {}), ...(renewed ? { setCookie: renewed } : {}) };
}

export function logoutCookies(url: URL): string[] {
  return [clearCookie(url, SESSION_COOKIE), clearCookie(url, DEV_COOKIE)];
}
